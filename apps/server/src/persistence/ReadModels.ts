/**
 * The projection tables the read side answers from.
 *
 * A thread's document is the whole `ThreadDetailSnapshot` as JSON — the
 * snapshot IS the projection, so reads are single-row fetches and replay is a
 * pure fold. Every write runs inside the command's transaction, so a
 * projection can never get ahead of its events.
 */

import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { ProjectSummary, ThreadSummary } from "@poseidon/contracts/orchestration";
import type { MessageSearchHit } from "@poseidon/contracts/search";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  clearMessageIndex,
  removeThreadMessages,
  searchMessages,
  syncThreadMessages,
} from "./MessageIndex";
import { layer as migrationsLayer } from "./Migrations";

import {
  projectSummaryOf,
  threadSummaryOf,
  type ProjectDoc,
  type ThreadDoc,
} from "../orchestration/state";

interface ProjectRow {
  readonly project_id: string;
  readonly name: string;
  readonly workspace_root: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly status: string;
  readonly doc_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const rowToProjectDoc = (row: ProjectRow): ProjectDoc => ({
  projectId: row.project_id as ProjectDoc["projectId"],
  name: row.name,
  workspaceRoot: row.workspace_root,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  removed: false,
});

const rowToThreadDoc = (row: ThreadRow): ThreadDoc => JSON.parse(row.doc_json) as ThreadDoc;

export class ReadModelStore extends Context.Service<
  ReadModelStore,
  {
    readonly putProject: (doc: ProjectDoc) => Effect.Effect<void, SqlError>;
    /** Removes the project row; its threads are deleted one by one. */
    readonly removeProject: (projectId: ProjectId) => Effect.Effect<void, SqlError>;
    readonly putThread: (doc: ThreadDoc) => Effect.Effect<void, SqlError>;
    readonly removeThread: (threadId: ThreadId) => Effect.Effect<void, SqlError>;
    readonly getThreadDoc: (threadId: ThreadId) => Effect.Effect<ThreadDoc | null, SqlError>;
    readonly getProjectDoc: (projectId: ProjectId) => Effect.Effect<ProjectDoc | null, SqlError>;
    readonly listProjects: () => Effect.Effect<ReadonlyArray<ProjectSummary>, SqlError>;
    readonly listThreads: (
      projectId?: ProjectId,
      includeArchived?: boolean,
    ) => Effect.Effect<ReadonlyArray<ThreadSummary>, SqlError>;
    /** Every stored thread document — the supervisor's resume scan. */
    readonly listThreadDocs: Effect.Effect<ReadonlyArray<ThreadDoc>, SqlError>;
    readonly projectExists: (projectId: ProjectId) => Effect.Effect<boolean, SqlError>;
    readonly workspaceRoots: Effect.Effect<ReadonlyArray<string>, SqlError>;
    readonly setWatermark: (
      projector: string,
      sequence: number,
      at: string,
      projectorVersion: number,
    ) => Effect.Effect<void, SqlError>;
    /** The projector version the stored rows were written by; `0` if none. */
    readonly projectorVersion: (projector: string) => Effect.Effect<number, SqlError>;
    /** Drops every projection row — the first half of a rebuild. */
    readonly clearProjections: Effect.Effect<void, SqlError>;
    /** Threads whose message text contains `query`; see `MessageIndex`. */
    readonly searchMessages: (
      query: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<MessageSearchHit>, SqlError>;
  }
>()("server/persistence/ReadModelStore") {
  static readonly layer = Layer.effect(
    ReadModelStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const putProject = (doc: ProjectDoc) =>
        sql`
          INSERT INTO projects (project_id, name, workspace_root, created_at, updated_at)
          VALUES (
            ${doc.projectId}, ${doc.name}, ${doc.workspaceRoot},
            ${doc.createdAt}, ${doc.updatedAt}
          )
          ON CONFLICT (project_id) DO UPDATE SET
            name = excluded.name,
            workspace_root = excluded.workspace_root,
            updated_at = excluded.updated_at
        `.pipe(Effect.asVoid);

      // Only the project row: its threads go through their own
      // `thread.deleted`, which is what closes their sessions and prunes their
      // checkpoints. Deleting the rows here would strand running connectors
      // with no projection left to append their output to.
      const removeProject = (projectId: ProjectId) =>
        sql`DELETE FROM projects WHERE project_id = ${projectId}`.pipe(Effect.asVoid);

      const putThread = (doc: ThreadDoc) =>
        sql`
          INSERT INTO threads (
            thread_id, project_id, title, status, doc_json, created_at, updated_at
          ) VALUES (
            ${doc.threadId}, ${doc.projectId}, ${doc.title}, ${doc.status},
            ${JSON.stringify(doc)}, ${doc.createdAt}, ${doc.updatedAt}
          )
          ON CONFLICT (thread_id) DO UPDATE SET
            project_id = excluded.project_id,
            title = excluded.title,
            status = excluded.status,
            doc_json = excluded.doc_json,
            updated_at = excluded.updated_at
        `.pipe(Effect.andThen(syncThreadMessages(sql, doc)));

      const removeThread = (threadId: ThreadId) =>
        sql`DELETE FROM threads WHERE thread_id = ${threadId}`.pipe(
          Effect.andThen(removeThreadMessages(sql, threadId)),
        );

      const getThreadDoc = (threadId: ThreadId) =>
        sql<ThreadRow>`
          SELECT thread_id, project_id, title, status, doc_json, created_at, updated_at
          FROM threads WHERE thread_id = ${threadId}
        `.pipe(Effect.map((rows) => (rows.length === 0 ? null : rowToThreadDoc(rows[0]!))));

      const getProjectDoc = (projectId: ProjectId) =>
        sql<ProjectRow>`
          SELECT project_id, name, workspace_root, created_at, updated_at
          FROM projects WHERE project_id = ${projectId}
        `.pipe(Effect.map((rows) => (rows.length === 0 ? null : rowToProjectDoc(rows[0]!))));

      const listProjects = () =>
        sql<ProjectRow & { readonly thread_count: number }>`
          SELECT p.project_id, p.name, p.workspace_root, p.created_at, p.updated_at,
            (SELECT COUNT(*) FROM threads t WHERE t.project_id = p.project_id)
              AS thread_count
          FROM projects p
          ORDER BY p.created_at
        `.pipe(
          Effect.map((rows) =>
            rows.map((row) => projectSummaryOf(rowToProjectDoc(row), row.thread_count)),
          ),
        );

      const listThreads = (projectId?: ProjectId, includeArchived = false) =>
        Effect.gen(function* () {
          const rows = yield* sql<ThreadRow>`
            SELECT thread_id, project_id, title, status, doc_json, created_at, updated_at
            FROM threads
            ORDER BY updated_at DESC
          `;
          return rows
            .map(rowToThreadDoc)
            .filter(
              (doc) =>
                (projectId === undefined || doc.projectId === projectId) &&
                (includeArchived || doc.status !== "archived"),
            )
            .map(threadSummaryOf);
        });

      const listThreadDocs = sql<ThreadRow>`
          SELECT thread_id, project_id, title, status, doc_json, created_at, updated_at
          FROM threads
        `.pipe(Effect.map((rows) => rows.map(rowToThreadDoc)));

      const projectExists = (projectId: ProjectId) =>
        sql<{ readonly n: number }>`
          SELECT 1 AS n FROM projects WHERE project_id = ${projectId}
        `.pipe(Effect.map((rows) => rows.length > 0));

      const workspaceRoots = sql<{ readonly workspace_root: string }>`
        SELECT workspace_root FROM projects
      `.pipe(Effect.map((rows) => rows.map((row) => row.workspace_root)));

      const setWatermark = (
        projector: string,
        sequence: number,
        at: string,
        projectorVersion: number,
      ) =>
        sql`
          INSERT INTO projection_state
            (projector, last_applied_sequence, updated_at, projector_version)
          VALUES (${projector}, ${sequence}, ${at}, ${projectorVersion})
          ON CONFLICT (projector) DO UPDATE SET
            last_applied_sequence = excluded.last_applied_sequence,
            updated_at = excluded.updated_at,
            projector_version = excluded.projector_version
        `.pipe(Effect.asVoid);

      const projectorVersion = (projector: string) =>
        sql<{ readonly projector_version: number }>`
          SELECT projector_version FROM projection_state WHERE projector = ${projector}
        `.pipe(Effect.map((rows) => rows[0]?.projector_version ?? 0));

      const clearProjections = Effect.all([
        sql`DELETE FROM threads`,
        sql`DELETE FROM projects`,
        clearMessageIndex(sql),
      ]).pipe(Effect.asVoid);

      return ReadModelStore.of({
        putProject,
        removeProject,
        putThread,
        removeThread,
        getThreadDoc,
        getProjectDoc,
        listProjects,
        listThreads,
        listThreadDocs,
        projectExists,
        workspaceRoots,
        setWatermark,
        projectorVersion,
        clearProjections,
        searchMessages: (query, limit) => searchMessages(sql, query, limit),
      });
    }),
  ).pipe(Layer.provide(migrationsLayer));
}

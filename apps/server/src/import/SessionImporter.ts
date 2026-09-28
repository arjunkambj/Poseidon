/**
 * `sessions.importable` and `sessions.import`: sessions a harness recorded on
 * its own, brought in as threads.
 *
 * The harness's files and its session reference are the connector's business
 * (each instance's `sessions` extension). This service only moves what the
 * extension answers: it lists every open instance's sessions, and imports one
 * with ordinary commands and events — `project.create` when no project is open
 * on the session's folder yet, `thread.create` for a local thread there (a
 * resume must run where the session ran), one `thread.item.upserted` per
 * message, and `thread.session.bound` when the instance can resume, so the
 * first turn carries the harness's own conversation on through the session
 * manager's usual resume path.
 *
 * The source files are only ever read. Which thread each session became is
 * kept in a small ledger (`ledger.ts`), so importing it again answers that
 * thread instead of a copy; a session one of Poseidon's own threads runs is
 * answered with that thread the same way. A failure after the thread exists deletes it, so a
 * retry starts clean; a project the import added stays, like any other.
 */

import { stat } from "node:fs/promises";
import * as NodePath from "node:path";

import type { ConnectorInstance } from "@poseidon/connector-sdk/definition";
import type {
  ConnectorExtensionFailed,
  ImportedTranscript,
  SessionsExtension,
} from "@poseidon/connector-sdk/extensions";
import { MAX_LISTED_SESSIONS } from "@poseidon/connector-sdk/sessionFiles";
import {
  makeCommandId,
  makeProjectId,
  makeThreadId,
  type ConnectorInstanceId,
  type ProjectId,
  type ThreadId,
} from "@poseidon/contracts/ids";
import type { Command } from "@poseidon/contracts/orchestration";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import type {
  ImportableSessionEntry,
  SessionImportResult,
} from "@poseidon/contracts/sessionImport";
import { configPath } from "@poseidon/shared/paths";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { EngineEnv, OrchestrationEngine } from "../orchestration/Engine";
import type { ThreadDoc } from "../orchestration/state";
import { ConnectorCatalog } from "../rpc/services";
import { ConnectorRegistryService } from "../settings/ConnectorManager";
import { LEDGER_FILE, ledgerKey, readLedger, writeLedger } from "./ledger";
import { sessionBoundEvent, transcriptEvents } from "./transcriptEvents";

export interface SessionImporterOptions {
  /** Where the ledger lives; `POSEIDON_HOME/session-imports.json` by default. */
  readonly ledgerPath: string;
}

const failure = (code: PoseidonRpcError["code"], message: string) =>
  new PoseidonRpcError({ code, message });

/** Anything below the RPC layer — SQL, the event store — said for a person. */
const internal = (what: string) => (error: unknown) =>
  Effect.logWarning(`session import: ${what} failed`, error).pipe(
    Effect.andThen(Effect.fail(failure("internal", `Could not ${what}.`))),
  );

const fromExtension = (error: ConnectorExtensionFailed) => failure(error.code, error.message);

/** Two spellings of one folder — a trailing slash, a `..` — are one project. */
const sameFolder = (a: string, b: string) => NodePath.resolve(a) === NodePath.resolve(b);

const isDirectory = (path: string) =>
  Effect.promise(() =>
    stat(path).then(
      (info) => info.isDirectory(),
      () => false,
    ),
  );

export class SessionImporter extends Context.Service<
  SessionImporter,
  {
    /** Every open instance's sessions, newest first; an instance that fails is skipped. */
    readonly importable: Effect.Effect<ReadonlyArray<ImportableSessionEntry>, PoseidonRpcError>;
    /** One session as a thread; a session still imported answers its thread again. */
    readonly importSession: (
      connectorInstanceId: ConnectorInstanceId,
      sourceId: string,
    ) => Effect.Effect<SessionImportResult, PoseidonRpcError>;
  }
>()("server/import/SessionImporter") {
  static readonly layerAt = (options: SessionImporterOptions) =>
    Layer.effect(
      SessionImporter,
      Effect.gen(function* () {
        const registry = yield* ConnectorRegistryService;
        const engine = yield* OrchestrationEngine;
        const catalog = yield* ConnectorCatalog;
        // One import at a time: two clicks on one row must not race each
        // other past the ledger into two threads.
        const importMutex = yield* Semaphore.make(1);

        const dispatch = (command: Command) =>
          engine.dispatch(command).pipe(
            Effect.catch(internal(`run ${command.type}`)),
            Effect.flatMap((receipt) =>
              receipt.status === "accepted"
                ? Effect.void
                : Effect.fail(failure("invalid", receipt.reason ?? `${command.type} was refused`)),
            ),
          );

        const liveThread = (threadId: ThreadId | undefined) =>
          threadId === undefined
            ? Effect.succeed(null)
            : engine.threadDoc(threadId).pipe(
                Effect.map((doc) => (doc === null || doc.deleted ? null : doc)),
                Effect.catch(internal("read the imported thread")),
              );

        const projectFor = (cwd: string) =>
          engine.listProjects().pipe(
            Effect.map(
              (projects) =>
                projects.find((project) => sameFolder(project.workspaceRoot, cwd))?.projectId ??
                null,
            ),
            Effect.catch(internal("list the projects")),
          );

        const sessionsOf = (instance: ConnectorInstance): SessionsExtension | undefined =>
          instance.extensions?.sessions;

        /**
         * The live threads that run one of the instance's sessions, by the
         * session's `sourceId`. Poseidon's own threads keep their sessions in
         * the harness's usual folders, so without this every one of them
         * would list as a session to import. Matched on the connector kind,
         * not the instance: two instances of a kind reading one folder list
         * the same sessions, and a session id names one session either way.
         */
        const threadsRunning = (instance: ConnectorInstance, docs: ReadonlyArray<ThreadDoc>) => {
          const sourceIdOf = sessionsOf(instance)?.sourceIdOf;
          const running = new Map<string, ThreadDoc>();
          if (sourceIdOf === undefined) return running;
          for (const doc of docs) {
            if (doc.deleted || doc.session?.connectorKind !== instance.kind) continue;
            const sourceId = sourceIdOf(doc.session.sessionRef);
            if (sourceId !== undefined && !running.has(sourceId)) running.set(sourceId, doc);
          }
          return running;
        };

        const threadDocs = engine.threadDocs.pipe(Effect.catch(internal("list the threads")));

        const importable = Effect.gen(function* () {
          const instances = (yield* registry.instances).filter(
            (instance) => sessionsOf(instance) !== undefined,
          );
          const names = new Map(
            (yield* catalog.list()).map((entry) => [entry.connectorInstanceId, entry.displayName]),
          );
          const projects = yield* engine
            .listProjects()
            .pipe(Effect.catch(internal("list the projects")));
          const ledger = yield* readLedger(options.ledgerPath);
          const docs = yield* threadDocs;
          const entries: Array<ImportableSessionEntry> = [];
          for (const instance of instances) {
            const sessions = yield* sessionsOf(instance)!
              .list({ limit: MAX_LISTED_SESSIONS })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `session import: could not list ${instance.instanceId}'s sessions`,
                    cause,
                  ).pipe(Effect.as([])),
                ),
              );
            const connectorName =
              names.get(instance.instanceId) ??
              registry.describe.find((entry) => entry.kind === instance.kind)?.metadata
                .displayName ??
              instance.kind;
            const running = threadsRunning(instance, docs);
            for (const session of sessions) {
              const imported =
                (yield* liveThread(ledger[ledgerKey(instance.instanceId, session.sourceId)])) ??
                running.get(session.sourceId) ??
                null;
              entries.push({
                ...session,
                connectorInstanceId: instance.instanceId,
                connectorKind: instance.kind,
                connectorName,
                projectId:
                  projects.find((project) => sameFolder(project.workspaceRoot, session.cwd))
                    ?.projectId ?? null,
                importedThreadId: imported?.threadId ?? null,
              });
            }
          }
          return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        });

        /** The session's project: the one open on its folder, else a new one there. */
        const ensureProject = (cwd: string) =>
          Effect.gen(function* () {
            const existing = yield* projectFor(cwd);
            if (existing !== null) return existing;
            if (!(yield* isDirectory(cwd))) {
              return yield* failure(
                "not-found",
                `The folder ${cwd} no longer exists, so the session has nowhere to run.`,
              );
            }
            const env = yield* EngineEnv;
            const projectId = makeProjectId();
            yield* dispatch({
              type: "project.create",
              commandId: makeCommandId(),
              createdAt: env.now(),
              projectId,
              name: NodePath.basename(cwd) || cwd,
              workspaceRoot: cwd,
            });
            return projectId;
          });

        /** Everything after `thread.create`; a failure here deletes the thread. */
        const fillThread = (
          instance: ConnectorInstance,
          threadId: ThreadId,
          transcript: ImportedTranscript,
          key: string,
        ) =>
          Effect.gen(function* () {
            const env = yield* EngineEnv;
            const resumes = instance.capabilities.resume && transcript.sessionRef != null;
            const events = [
              ...transcriptEvents(threadId, transcript.messages, env),
              ...(resumes
                ? [
                    sessionBoundEvent(
                      threadId,
                      {
                        connectorInstanceId: instance.instanceId,
                        connectorKind: instance.kind,
                        sessionRef: transcript.sessionRef,
                      },
                      env,
                    ),
                  ]
                : []),
            ];
            yield* engine
              .appendThreadEvents(threadId, events)
              .pipe(Effect.catch(internal("write the transcript")));
            const ledger = yield* readLedger(options.ledgerPath);
            yield* writeLedger(options.ledgerPath, { ...ledger, [key]: threadId }).pipe(
              Effect.catch(internal("record the import")),
            );
            return resumes;
          });

        const importSession = (connectorInstanceId: ConnectorInstanceId, sourceId: string) =>
          importMutex.withPermits(1)(
            Effect.gen(function* () {
              const instance = yield* registry
                .instance(connectorInstanceId)
                .pipe(
                  Effect.mapError(() =>
                    failure(
                      "unavailable",
                      `Connector instance ${connectorInstanceId} is not open.`,
                    ),
                  ),
                );
              const sessions = sessionsOf(instance);
              if (sessions === undefined) {
                return yield* failure(
                  "unavailable",
                  `Connector instance ${connectorInstanceId} has no sessions to import.`,
                );
              }
              const key = ledgerKey(connectorInstanceId, sourceId);
              // An earlier import of it, else a thread of Poseidon's own that
              // runs it: either is the session already, and no copy is made.
              const earlier =
                (yield* liveThread((yield* readLedger(options.ledgerPath))[key])) ??
                threadsRunning(instance, yield* threadDocs).get(sourceId) ??
                null;
              if (earlier !== null) {
                return {
                  threadId: earlier.threadId,
                  projectId: earlier.projectId,
                  resumes: earlier.session !== null,
                };
              }

              const transcript = yield* sessions
                .read(sourceId)
                .pipe(Effect.mapError(fromExtension));
              const projectId: ProjectId = yield* ensureProject(transcript.session.cwd);
              const env = yield* EngineEnv;
              const threadId = makeThreadId();
              yield* dispatch({
                type: "thread.create",
                commandId: makeCommandId(),
                createdAt: env.now(),
                threadId,
                projectId,
                title: transcript.session.title,
                settings: { connectorInstanceId },
              });
              const resumes = yield* fillThread(instance, threadId, transcript, key).pipe(
                Effect.onError(() =>
                  dispatch({
                    type: "thread.delete",
                    commandId: makeCommandId(),
                    createdAt: env.now(),
                    threadId,
                  }).pipe(Effect.ignore),
                ),
              );
              return { threadId, projectId, resumes };
            }),
          );

        return SessionImporter.of({ importable, importSession });
      }),
    );

  static readonly layer = Layer.unwrap(
    Effect.sync(() => SessionImporter.layerAt({ ledgerPath: configPath([LEDGER_FILE]) })),
  );

  /** Nothing to import, for tests that wire the handlers without connectors. */
  static readonly empty = Layer.succeed(
    SessionImporter,
    SessionImporter.of({
      importable: Effect.succeed([]),
      importSession: () => Effect.fail(failure("unavailable", "there are no sessions to import")),
    }),
  );
}

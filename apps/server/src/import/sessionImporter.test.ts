/**
 * `SessionImporter` over the real Claude Code session reader, pointed at a
 * temporary copy of `fixtures/claude/session-files/` whose `<HOME>` paths are
 * rewritten into a temporary home. The instances around it are fakes: one
 * that can resume, one that cannot, and one whose list always fails. The
 * engine, its database and the ledger are real, and every copied source file
 * is hashed before and after to show nothing wrote to it.
 */

import { createHash } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { makeClaudeSessionFiles } from "@poseidon/connector-claude/sessionFiles";
import type { ConnectorServices } from "@poseidon/connector-sdk/definition";
import { eraseConnectorDefinition } from "@poseidon/connector-sdk/definition";
import { ConnectorExtensionFailed } from "@poseidon/connector-sdk/extensions";
import { makeRegistry } from "@poseidon/connector-sdk/registry";
import type { ConnectorSummary } from "@poseidon/contracts/connectors";
import {
  makeCommandId,
  makeConnectorInstanceId,
  makeProjectId,
  makeThreadId,
  type ConnectorInstanceId,
} from "@poseidon/contracts/ids";
import { ImportableSessionEntry } from "@poseidon/contracts/sessionImport";
import { fixturesRoot } from "@poseidon/testkit/recording";
import { makeFakeConnector } from "@poseidon/testkit/fakeConnector";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import { persistenceLayer } from "../../test/layers";
import { EngineEnv, OrchestrationEngine } from "../orchestration/Engine";
import { ConnectorCatalog } from "../rpc/services";
import { ConnectorRegistryService } from "../settings/ConnectorManager";
import { ConnectorModels, OpenConnectors } from "../settings/connectorRouting";
import { ledgerKey } from "./ledger";
import { SessionImporter } from "./SessionImporter";

const FIXTURE = NodePath.join(fixturesRoot("claude"), "session-files");
const ALPHA_ID = "0b6f3c1e-5a2d-4c8e-9f10-2a3b4c5d6e01";
const NOISY_ID = "0b6f3c1e-5a2d-4c8e-9f10-2a3b4c5d6e02";
const BETA_ID = "0b6f3c1e-5a2d-4c8e-9f10-2a3b4c5d6e03";
const ALPHA_DIR = NodePath.join("projects", "-HOME-code-alpha");
const BETA_DIR = NodePath.join("projects", "-HOME-code-beta");

const MTIMES: ReadonlyArray<readonly [string, string]> = [
  [NodePath.join(ALPHA_DIR, `${ALPHA_ID}.jsonl`), "2026-09-20T10:05:00.000Z"],
  [NodePath.join(ALPHA_DIR, `${NOISY_ID}.jsonl`), "2026-09-21T09:35:00.000Z"],
  [NodePath.join(BETA_DIR, `${BETA_ID}.jsonl`), "2026-09-22T14:20:00.000Z"],
];

const services: Effect.Effect<ConnectorServices> = Effect.clockWith((clock) =>
  Effect.succeed({
    mcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/mcp", bearer: "t" }),
    hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/hook", bearer: "t" }),
    permissions: { decide: () => Effect.succeed("prompt" as const) },
    attachmentsDir: "/tmp/poseidon-session-import-test",
    logger: { log: () => Effect.void },
    clock,
  }),
);

/**
 * A config directory holding the fixture's sessions, with `<HOME>` spelled as
 * a real temporary home. Only the alpha folder exists there; beta's is gone.
 */
const copyFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "session-importer-"));
  const home = NodePath.join(root, "home");
  const config = NodePath.join(root, "claude");
  NodeFS.cpSync(FIXTURE, config, { recursive: true });
  for (const name of NodeFS.readdirSync(config, { recursive: true }) as Array<string>) {
    const path = NodePath.join(config, name);
    if (name.endsWith(".jsonl") && NodeFS.statSync(path).isFile()) {
      NodeFS.writeFileSync(path, NodeFS.readFileSync(path, "utf8").replaceAll("<HOME>", home));
    }
  }
  for (const [file, at] of MTIMES) {
    const time = new Date(at);
    NodeFS.utimesSync(NodePath.join(config, file), time, time);
  }
  const alpha = NodePath.join(home, "code", "alpha");
  NodeFS.mkdirSync(alpha, { recursive: true });
  return { root, config, alpha, beta: NodePath.join(home, "code", "beta") };
};

/** Every file under `root`, with its content hash and last write. */
const snapshot = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of NodeFS.readdirSync(root, { recursive: true }) as Array<string>) {
    const path = NodePath.join(root, name);
    const info = NodeFS.statSync(path);
    if (!info.isFile()) continue;
    const hash = createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
    out[name] = `${hash} ${info.mtimeMs}`;
  }
  return out;
};

const summary = (connectorInstanceId: ConnectorInstanceId, displayName: string) =>
  ({ connectorInstanceId, displayName }) as ConnectorSummary;

/**
 * Three open instances over one engine: `resuming` (Claude's reader, resume
 * on), `fresh` (the same reader, resume off) and `broken` (a list that fails).
 */
const fixture = (options: { readonly ledgerPath?: string } = {}) =>
  Effect.gen(function* () {
    const files = copyFixture();
    const reader = makeClaudeSessionFiles({ env: { CLAUDE_CONFIG_DIR: files.config } });
    const resumingConnector = yield* makeFakeConnector({
      kind: "fake-resuming",
      extensions: { sessions: reader },
    });
    const freshConnector = yield* makeFakeConnector({
      kind: "fake-fresh",
      capabilities: { resume: false },
      extensions: { sessions: reader },
    });
    const brokenConnector = yield* makeFakeConnector({
      kind: "fake-broken",
      extensions: {
        sessions: {
          list: () =>
            Effect.fail(new ConnectorExtensionFailed({ code: "internal", message: "unreadable" })),
          read: () =>
            Effect.fail(new ConnectorExtensionFailed({ code: "internal", message: "unreadable" })),
        },
      },
    });
    const registry = yield* makeRegistry(
      [resumingConnector, freshConnector, brokenConnector].map((c) =>
        eraseConnectorDefinition(c.definition),
      ),
    );
    const resuming = makeConnectorInstanceId();
    const fresh = makeConnectorInstanceId();
    const broken = makeConnectorInstanceId();
    for (const [instanceId, kind] of [
      [resuming, "fake-resuming"],
      [fresh, "fake-fresh"],
      [broken, "fake-broken"],
    ] as const) {
      yield* registry.open({ instanceId, kind, config: {}, services: yield* services });
    }

    const engineLayer = OrchestrationEngine.layer.pipe(
      Layer.provide(persistenceLayer()),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OpenConnectors, Effect.succeed([resuming, fresh, broken])),
          Layer.succeed(ConnectorModels, () => Effect.succeed(["fake/model"])),
        ),
      ),
    );
    const catalog = Layer.succeed(
      ConnectorCatalog,
      ConnectorCatalog.of({
        list: () => Effect.succeed([summary(resuming, "Resuming harness")]),
        changes: Stream.never,
        models: () => Effect.succeed([]),
        describe: Effect.succeed([]),
      }),
    );
    const ledgerPath = options.ledgerPath ?? NodePath.join(files.root, "poseidon", "imports.json");
    const context = yield* Layer.build(
      SessionImporter.layerAt({ ledgerPath }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(engineLayer, catalog, Layer.succeed(ConnectorRegistryService, registry)),
        ),
      ),
    );
    return {
      files,
      ledgerPath,
      before: snapshot(files.config),
      importer: Context.get(context, SessionImporter),
      engine: Context.get(context, OrchestrationEngine),
      resuming,
      fresh,
      broken,
    };
  });

describe("SessionImporter", () => {
  it.effect("lists every instance's sessions newest first, past one that fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { importer, resuming, fresh, files } = yield* fixture();
        const entries = yield* importer.importable;
        // Both readers see the same three sessions; the broken one adds none.
        expect(entries).toHaveLength(6);
        expect(entries.map((entry) => entry.sourceId)).toEqual([
          BETA_ID,
          BETA_ID,
          NOISY_ID,
          NOISY_ID,
          ALPHA_ID,
          ALPHA_ID,
        ]);
        const alpha = entries.find(
          (entry) => entry.sourceId === ALPHA_ID && entry.connectorInstanceId === resuming,
        );
        expect(alpha).toMatchObject({
          cwd: files.alpha,
          title: "Alpha README",
          connectorKind: "fake-resuming",
          connectorName: "Resuming harness",
          projectId: null,
          importedThreadId: null,
        });
        // An instance the catalog does not name falls back to its connector's name.
        const freshName = entries.find(
          (entry) => entry.connectorInstanceId === fresh,
        )?.connectorName;
        expect(freshName).toBeTruthy();
        expect(freshName).not.toBe("Resuming harness");
        for (const entry of entries) {
          expect(Schema.decodeUnknownSync(ImportableSessionEntry)(entry)).toEqual(entry);
        }
      }),
    ),
  );

  it.effect(
    "imports a session as a thread holding its transcript, to resume on its first turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { importer, engine, resuming, files, before } = yield* fixture();
          const result = yield* importer.importSession(resuming, ALPHA_ID);
          expect(result.resumes).toBe(true);

          const projects = yield* engine.listProjects();
          expect(projects).toHaveLength(1);
          expect(projects[0]).toMatchObject({
            projectId: result.projectId,
            name: "alpha",
            workspaceRoot: files.alpha,
          });

          const doc = yield* engine.threadDoc(result.threadId);
          expect(doc).not.toBeNull();
          expect(doc!.title).toBe("Alpha README");
          expect(doc!.projectId).toBe(result.projectId);
          expect(doc!.worktree ?? null).toBeNull();
          expect(doc!.settings.connectorInstanceId).toBe(resuming);
          expect(doc!.status).toBe("idle");
          expect(doc!.items.map((item) => [item.kind, item.status, item.text])).toEqual([
            ["user_message", "completed", "Add a README to the alpha project"],
            ["assistant_message", "completed", "I'll add a short README."],
            ["assistant_message", "completed", "README.md is in place."],
            ["user_message", "completed", "Also mention the licence"],
            ["assistant_message", "completed", "Added a licence line."],
          ]);
          // Each user message opens a turn; the replies after it share it.
          const turns = doc!.items.map((item) => item.turnId);
          expect(turns[0]).toBeDefined();
          expect(turns[1]).toBe(turns[0]);
          expect(turns[2]).toBe(turns[0]);
          expect(turns[3]).not.toBe(turns[0]);
          expect(turns[4]).toBe(turns[3]);

          // Recorded, not bound: the boot scan resumes only bound sessions.
          expect(doc!.session).toBeNull();
          expect(doc!.imported).toEqual({
            connectorKind: "fake-resuming",
            sourceId: ALPHA_ID,
            session: {
              connectorInstanceId: resuming,
              sessionRef: { sessionId: ALPHA_ID, cwd: files.alpha },
            },
          });
          expect(snapshot(files.config)).toEqual(before);
        }),
      ),
  );

  it.effect("reuses the folder's project and leaves a non-resuming thread unbound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { importer, engine, resuming, fresh } = yield* fixture();
        const first = yield* importer.importSession(resuming, ALPHA_ID);
        const second = yield* importer.importSession(fresh, NOISY_ID);
        expect(second.projectId).toBe(first.projectId);
        expect(second.resumes).toBe(false);
        expect(yield* engine.listProjects()).toHaveLength(1);
        const doc = yield* engine.threadDoc(second.threadId);
        expect(doc!.session).toBeNull();
        expect(doc!.imported).toEqual({ connectorKind: "fake-fresh", sourceId: NOISY_ID });
        expect(doc!.items.map((item) => item.text)).toEqual([
          "Explain how the retry loop in the fetch helper decides when to stop, and whether it waits between attempts at all",
          "It stops after three attempts,\n\nand it doubles the wait between them.",
          "Thanks",
          "You're welcome.",
        ]);
      }),
    ),
  );

  it.effect("dates imported threads by their sessions, so a batch lists in source order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { importer, engine, resuming } = yield* fixture();
        // Newest first, the order the import panel runs a selection in.
        const noisy = yield* importer.importSession(resuming, NOISY_ID);
        const alpha = yield* importer.importSession(resuming, ALPHA_ID);
        const threads = yield* engine.listThreads(alpha.projectId);
        expect(threads.map((thread) => thread.threadId)).toEqual([noisy.threadId, alpha.threadId]);
        // Each thread's last update is its session's last message, not the import.
        const alphaDoc = yield* engine.threadDoc(alpha.threadId);
        expect(alphaDoc!.updatedAt).toBe("2026-09-20T10:00:06.000Z");
        expect(threads[0]!.updatedAt.startsWith("2026-09-21T09:30:")).toBe(true);
      }),
    ),
  );

  it.effect("marks an imported session, and imports it only once while its thread lives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { importer, engine, resuming, ledgerPath } = yield* fixture();
        const first = yield* importer.importSession(resuming, ALPHA_ID);
        const again = yield* importer.importSession(resuming, ALPHA_ID);
        expect(again).toEqual(first);
        expect(yield* engine.listThreads(undefined, true)).toHaveLength(1);
        expect(JSON.parse(NodeFS.readFileSync(ledgerPath, "utf8"))).toEqual({
          [ledgerKey(resuming, ALPHA_ID)]: first.threadId,
        });
        // No temporary file is left beside the ledger.
        expect(NodeFS.readdirSync(NodePath.dirname(ledgerPath))).toEqual(["imports.json"]);

        const listed = yield* importer.importable;
        const alpha = listed.find(
          (entry) => entry.sourceId === ALPHA_ID && entry.connectorInstanceId === resuming,
        );
        expect(alpha?.importedThreadId).toBe(first.threadId);
        expect(alpha?.projectId).toBe(first.projectId);
        // The same session read through another instance is its own import.
        const other = listed.find(
          (entry) => entry.sourceId === ALPHA_ID && entry.connectorInstanceId !== resuming,
        );
        expect(other?.importedThreadId).toBeNull();
        // The thread's own record of the import names it without the ledger.
        NodeFS.rmSync(ledgerPath);
        expect(
          (yield* importer.importable).find(
            (entry) => entry.sourceId === ALPHA_ID && entry.connectorInstanceId === resuming,
          )?.importedThreadId,
        ).toBe(first.threadId);
        expect(yield* importer.importSession(resuming, ALPHA_ID)).toEqual(first);

        // Once the thread is deleted the session is importable again.
        yield* engine.dispatch({
          type: "thread.delete",
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          threadId: first.threadId,
        });
        const relisted = yield* importer.importable;
        expect(
          relisted.find(
            (entry) => entry.sourceId === ALPHA_ID && entry.connectorInstanceId === resuming,
          )?.importedThreadId,
        ).toBeNull();
        const reimported = yield* importer.importSession(resuming, ALPHA_ID);
        expect(reimported.threadId).not.toBe(first.threadId);
      }),
    ),
  );

  it.effect("names the thread already running a session, and never imports it as a copy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { importer, engine, resuming, fresh, files, ledgerPath } = yield* fixture();
        // A thread of Poseidon's own that runs the alpha session.
        const projectId = makeProjectId();
        const threadId = makeThreadId();
        const now = new Date().toISOString();
        yield* engine.dispatch({
          type: "project.create",
          commandId: makeCommandId(),
          createdAt: now,
          projectId,
          name: "alpha",
          workspaceRoot: files.alpha,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: makeCommandId(),
          createdAt: now,
          threadId,
          projectId,
          title: "Running here",
          settings: { connectorInstanceId: resuming },
        });
        const env = yield* EngineEnv;
        yield* engine.appendThreadEvents(threadId, [
          {
            eventId: env.nextEventId(),
            streamKind: "thread",
            streamId: threadId,
            occurredAt: env.now(),
            actor: "connector",
            type: "thread.session.bound",
            payload: {
              connectorInstanceId: resuming,
              connectorKind: "fake-resuming",
              sessionRef: { sessionId: ALPHA_ID, cwd: files.alpha },
            },
          },
        ]);

        const listed = yield* importer.importable;
        const alpha = listed.find(
          (entry) => entry.sourceId === ALPHA_ID && entry.connectorInstanceId === resuming,
        );
        expect(alpha).toMatchObject({ importedThreadId: threadId, projectId });
        // A session the thread does not run, and one read by another kind, stay importable.
        expect(
          listed.find(
            (entry) => entry.sourceId === NOISY_ID && entry.connectorInstanceId === resuming,
          )?.importedThreadId,
        ).toBeNull();
        expect(
          listed.find((entry) => entry.sourceId === ALPHA_ID && entry.connectorInstanceId === fresh)
            ?.importedThreadId,
        ).toBeNull();

        const result = yield* importer.importSession(resuming, ALPHA_ID);
        expect(result).toEqual({ threadId, projectId, resumes: true });
        expect(yield* engine.listThreads(undefined, true)).toHaveLength(1);
        // Nothing was imported, so nothing was recorded.
        expect(NodeFS.existsSync(ledgerPath)).toBe(false);
      }),
    ),
  );

  it.effect("fails a session whose folder is gone, leaving no project or thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { importer, engine, resuming, files } = yield* fixture();
        const error = yield* Effect.flip(importer.importSession(resuming, BETA_ID));
        expect(error.code).toBe("not-found");
        expect(error.message).toContain(files.beta);
        expect(error.message).toContain("no longer exists");
        expect(yield* engine.listProjects()).toEqual([]);
        expect(yield* engine.listThreads(undefined, true)).toEqual([]);
      }),
    ),
  );

  it.effect("deletes the thread when a step after its creation fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A directory where the ledger should be: the import cannot record
        // itself, so the thread it made is taken back.
        const blocked = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "session-ledger-"));
        NodeFS.writeFileSync(NodePath.join(blocked, "occupied"), "");
        const { importer, engine, resuming } = yield* fixture({ ledgerPath: blocked });
        const error = yield* Effect.flip(importer.importSession(resuming, ALPHA_ID));
        expect(error.code).toBe("internal");
        expect(yield* engine.listThreads(undefined, true)).toEqual([]);
        // The project it added stays, like any other.
        expect(yield* engine.listProjects()).toHaveLength(1);
      }),
    ),
  );

  it.effect("refuses an instance that is not open, and passes a reader's failure on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { importer, broken } = yield* fixture();
        const closed = yield* Effect.flip(
          importer.importSession(makeConnectorInstanceId(), ALPHA_ID),
        );
        expect(closed.code).toBe("unavailable");
        const failing = yield* Effect.flip(importer.importSession(broken, ALPHA_ID));
        expect(failing.code).toBe("internal");
        expect(failing.message).toBe("unreadable");
      }),
    ),
  );
});

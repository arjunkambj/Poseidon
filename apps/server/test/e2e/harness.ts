/**
 * The end-to-end harness: one real server, one real client, one real CLI.
 *
 * Every other suite in the repo builds a subset — an engine over an in-memory
 * database, a connector with a stub host, a renderer fold over hand-made
 * events. This one builds the product: `boot()` from `apps/server/src/boot.ts`
 * assembles the same graph `main.ts` ships, `makeConnection` from
 * `@poseidon/client-runtime` dials it over a real WebSocket, and the folds the
 * renderer's atoms use (`applyThreadStreamItem`, `applyThreadListItem`) turn
 * the subscription into the very view a pane renders. What the assertions look
 * at is therefore what a user would see.
 *
 * Underneath sits one of two drivers, and that is the only difference between
 * a live run and the gate's:
 *
 * - `liveDriver` lets the connector discover the operator's own `cmd` and
 *   spends their plan. It is opt-in (`POSEIDON_LIVE_CMD=1`).
 * - `replayDriver` points the connector's binary path at testkit's replayer,
 *   which puts a recording of that same run back on the wire. It is what runs
 *   in the gate.
 *
 * Nothing waits on a clock. Commands are awaited through their receipts and
 * everything else through the subscription, so a scenario that never happens
 * ends as a failed `awaitItem` rather than a slow pass.
 *
 * Safety: every test gets a fresh `POSEIDON_HOME` and a throwaway git repo
 * under the system temp directory, so nothing here can touch the operator's
 * real `~/.poseidon`. The replay driver also redirects `HOME`, so it cannot
 * touch `~/.commandcode` either; the live driver deliberately does not, since
 * that is where the CLI's credentials live — the only thing it writes there is
 * the session record the CLI writes for any run.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ThreadDetailView } from "@poseidon/client-runtime/clientState";
import {
  Connection,
  makeConnection,
  type ConnectionCredentials,
  type ConnectionState,
  type PoseidonRpcClient,
} from "@poseidon/client-runtime/connection";
import {
  makeCommandId,
  makeConnectorInstanceId,
  makeProjectId,
  makeThreadId,
} from "@poseidon/contracts/ids";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type {
  Attachment,
  Command,
  CommandReceipt,
  ThreadSettingsPatch,
} from "@poseidon/contracts/orchestration";
import { defaultSettings } from "@poseidon/contracts/settings";
import { DEFAULT_GENERATION_SETTINGS } from "@poseidon/contracts/generation";
import type { ConnectorInstanceConfig } from "@poseidon/contracts/settings";
import { replayConfig } from "@poseidon/testkit/replayCmdProcess";
import { describe, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { watchThread, type ThreadWatch, type ViewMark, type Watch } from "./watch";

import { boot, type BootedServer, type BootOptions } from "../../src/boot";
import { layer as sqliteLayer } from "../../src/persistence/Sqlite";
import { SettingsStore } from "../../src/rpc/services";
import { DEFAULT_MODEL_MIGRATION, RANK_MIGRATION } from "../../src/settings/connectorUpgrade";

/**
 * The model every scenario runs on.
 *
 * `cmd --list-models` offers about seventy and most of them bill the
 * operator's card. Three are authorised for spending; this is the account
 * default, which is also the one every recording under
 * `packages/testkit/fixtures/cmd/` was made on, so the live and replay drivers
 * name the same model and `recordedArgs.test.ts` keeps them honest.
 */
export const E2E_MODEL = "meta/muse-spark-1.3-contributor";

/** Whether the live driver may spend the operator's plan. */
const LIVE = process.env.POSEIDON_LIVE_CMD === "1";

// ── Homes ──────────────────────────────────────────────────────

export interface E2EHome {
  /** The temp root everything below hangs off; removed with the scope. */
  readonly root: string;
  /** `POSEIDON_HOME` for this boot: database, attachments, hook script. */
  readonly poseidon: string;
  /** A `HOME` for anything the replay driver spawns. */
  readonly cmdHome: string;
  /** A git repository to use as the project's workspace root. */
  readonly workspace: string;
}

/** Seeds a throwaway git repo so the harness sees an ordinary workspace. */
const initWorkspace = (workspace: string, seed: Readonly<Record<string, string>>): void => {
  NodeFS.mkdirSync(workspace, { recursive: true });
  for (const [name, content] of Object.entries(seed)) {
    NodeFS.writeFileSync(NodePath.join(workspace, name), content, "utf8");
  }
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "e2e@example.invalid"],
    ["config", "user.name", "e2e"],
    ["add", "-A"],
    ["commit", "-q", "-m", "seed", "--allow-empty"],
  ]) {
    execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
  }
};

/**
 * A fresh home bound to the calling scope. `seed` is written into the
 * workspace and committed, so a checkpoint diff has something to be a diff of.
 * `parent` is where it is made — the system temp directory unless a recording
 * says otherwise.
 */
export const makeHome = (
  label: string,
  seed: Readonly<Record<string, string>> = {},
  parent: string = NodeOS.tmpdir(),
): Effect.Effect<E2EHome, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => {
        NodeFS.mkdirSync(parent, { recursive: true });
        return NodeFS.mkdtempSync(NodePath.join(parent, `poseidon-e2e-${label}-`));
      }),
      (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
    );
    const home: E2EHome = {
      root,
      poseidon: NodePath.join(root, "poseidon"),
      cmdHome: NodePath.join(root, "cmd-home"),
      workspace: NodePath.join(root, "workspace"),
    };
    yield* Effect.sync(() => {
      NodeFS.mkdirSync(home.poseidon, { recursive: true });
      NodeFS.mkdirSync(home.cmdHome, { recursive: true });
      initWorkspace(home.workspace, seed);
    });
    return home;
  });

// ── Drivers ────────────────────────────────────────────────────

export interface Driver {
  readonly name: "live" | "replay";
  /**
   * The connector instance a scenario runs on. `recording` names the fixture
   * the replay driver plays back; the live driver ignores it and discovers the
   * operator's own `cmd` exactly as the shipped product does.
   */
  readonly connector: (home: E2EHome, recording: string) => ConnectorInstanceConfig;
  /**
   * The home the connector's *sessions* resolve `~/.commandcode` against.
   *
   * Not the same as the one `boot` is given for the settings pages: a live
   * session inherits the operator's real `HOME`, because that is where the
   * CLI's credentials are, so anything the harness writes for it lands there.
   */
  readonly harnessHome: (home: E2EHome) => string;
}

/**
 * The real CLI. `binaryPath` is deliberately absent so `probe.ts`'s own
 * discovery runs — finding `cmd` on PATH is part of what a live run proves —
 * and `extraEnv` is empty so the child inherits the operator's `HOME`, which
 * is where the CLI keeps its credentials.
 */
const liveDriver: Driver = {
  name: "live",
  harnessHome: () => NodeOS.homedir(),
  connector: () => ({
    connectorInstanceId: makeConnectorInstanceId(),
    kind: "cmd",
    displayName: "Command Code",
    enabled: true,
    config: {},
  }),
};

/** The same connector, spawning a recording instead of a model. */
const replayDriver: Driver = {
  name: "replay",
  harnessHome: (home) => home.cmdHome,
  connector: (home, recording) => {
    const replay = replayConfig(recording, { home: home.cmdHome });
    return {
      connectorInstanceId: makeConnectorInstanceId(),
      kind: "cmd",
      displayName: "Command Code",
      enabled: true,
      config: { binaryPath: replay.binaryPath, extraEnv: replay.extraEnv },
    };
  },
};

/** Both drivers, with the live one skipped unless it is turned on. */
const drivers: ReadonlyArray<Driver> = [replayDriver, liveDriver];

/**
 * Runs one scenario body against both drivers.
 *
 * The same assertions run twice: once against a recording, which is what the
 * gate does, and once against the real CLI, which is what says the recording
 * still describes reality. A scenario that needs different expectations from
 * the two is a scenario whose recording has gone stale.
 *
 * A live turn is a model round trip — seconds, not the five vitest allows — so
 * turning the live driver on also lifts the timeout for the whole file.
 */
export const forEachDriver = (title: string, body: (driver: Driver) => void): void => {
  for (const driver of drivers) {
    if (driver.name === "live" && !LIVE) {
      describe.skip(`${title} [live]`, () => {
        it("is only run with POSEIDON_LIVE_CMD=1 — it spends the operator's plan", () => {
          // Intentionally empty: the skip itself is the statement.
        });
      });
      continue;
    }
    // Even a replay is several real processes, a real socket and a real
    // database, and a multi-turn scenario spawns the replayer once per turn —
    // comfortably past the five seconds vitest allows by default. A live turn
    // is a model round trip on top of that.
    vi.setConfig({
      testTimeout: driver.name === "live" ? 600_000 : 120_000,
      hookTimeout: 120_000,
    });
    describe(`${title} [${driver.name}]`, () => body(driver));
  }
};

// ── The server ─────────────────────────────────────────────────

/**
 * Writes the settings row `boot` will find.
 *
 * Without one the connector manager treats the home as a fresh install and
 * seeds an instance of every harness it ships — which is right for a first run
 * and wrong for a test, because then the test cannot say which binary the
 * instance points at, and a new thread routes to Claude Code. So the row also
 * says every kind was offered and every connector upgrade applied
 * (`connectorUpgrade.ts`): the manager then leaves `connectors` exactly as the
 * test wrote it, and a thread routes to the one it names. Automatic thread
 * titles are switched off in it.
 */
export const seedSettings = (
  home: E2EHome,
  connectors: ReadonlyArray<ConnectorInstanceConfig>,
): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sqlite = Layer.succeedContext(
        yield* Layer.build(sqliteLayer({ filename: NodePath.join(home.poseidon, "state.sqlite") })),
      );
      const store = Context.get(
        yield* Layer.build(SettingsStore.layer.pipe(Layer.provide(sqlite))),
        SettingsStore,
      );
      // Automatic titles off: they would add a one-shot harness call to every
      // first turn, and a recording holds only the session it was made from.
      yield* store.update({
        ...defaultSettings(),
        connectors,
        offeredConnectorKinds: ["claude", "codex", "cmd"],
        connectorMigrations: [RANK_MIGRATION, DEFAULT_MODEL_MIGRATION],
        generation: { ...DEFAULT_GENERATION_SETTINGS, autoTitle: false },
      });
    }),
  ).pipe(Effect.orDie);

/**
 * Boots the real graph in the calling scope and restores `POSEIDON_HOME` when
 * it closes — `boot` sets the variable process-wide on purpose, so that
 * spawned children inherit it, and a test must not leave it pointing at a
 * directory it is about to delete.
 */
export const bootServer = (
  home: E2EHome,
  options: { readonly dev?: boolean; readonly claudeCode?: BootOptions["claudeCode"] } = {},
) =>
  Effect.acquireRelease(
    Effect.sync(() => process.env.POSEIDON_HOME),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env.POSEIDON_HOME;
        } else {
          process.env.POSEIDON_HOME = previous;
        }
      }),
  ).pipe(
    Effect.andThen(
      boot({
        home: home.poseidon,
        dev: options.dev ?? false,
        port: 0,
        // The harness's own config, redirected for both drivers. `POSEIDON_HOME`
        // cannot move it — it is the user's `~/.commandcode` — so without this
        // the settings scenario would edit the operator's real one.
        commandCodeHome: NodePath.join(home.cmdHome, ".commandcode"),
        ...(options.claudeCode === undefined ? {} : { claudeCode: options.claudeCode }),
      }),
    ),
    Effect.orDie,
  );

// ── The client ─────────────────────────────────────────────────

export interface E2EClient {
  /**
   * The live RPC client, re-resolved on every use.
   *
   * Not a held reference: Effect's socket protocol is single-use, so a
   * reconnect builds a new client underneath and anything holding the old one
   * is talking to a closed socket. This is the same per-call accessor the
   * renderer's atoms use, which is what lets a scenario restart the server
   * under a client and keep going.
   */
  readonly rpc: Effect.Effect<PoseidonRpcClient>;
  /** The connection's own state, for asserting a reconnect really happened. */
  readonly state: SubscriptionRef.SubscriptionRef<ConnectionState>;
  /** Dispatches and returns the receipt, so a caller can wait for its write. */
  readonly dispatch: (command: Command) => Effect.Effect<CommandReceipt>;
  /** Dispatches and fails the test if the server rejected the command. */
  readonly send: (command: Command) => Effect.Effect<CommandReceipt>;
}

/**
 * A client on the running server.
 *
 * `credentials` is an effect rather than a value because the crash-and-restart
 * scenario needs the renderer's real behaviour: the server binds an ephemeral
 * port and mints a new token every boot, so `makeConnection` re-reads its
 * credentials before every attempt and lands on the new server instead of
 * looping against a dead port.
 */
export const connect = (
  credentials: Effect.Effect<ConnectionCredentials | null>,
): Effect.Effect<E2EClient, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const first = yield* credentials;
    const context = yield* Layer.build(
      makeConnection({
        ...(first === null ? {} : { url: first.url, token: first.token }),
        resolve: credentials,
      }),
    );
    const connection = Context.get(context, Connection);
    const rpc = connection.client;
    const dispatch = (command: Command): Effect.Effect<CommandReceipt> =>
      rpc.pipe(
        Effect.flatMap((client) => client["orchestration.dispatch"]({ command })),
        Effect.orDie,
      );
    return {
      rpc,
      state: connection.state,
      dispatch,
      send: (command) =>
        dispatch(command).pipe(
          Effect.flatMap((receipt) =>
            receipt.status === "accepted"
              ? Effect.succeed(receipt)
              : Effect.die(
                  new Error(`${command.type} was rejected: ${receipt.reason ?? "no reason given"}`),
                ),
          ),
        ),
    };
  });

/**
 * Waits for the connection to come back up, after `after`.
 *
 * This is the renderer's own signal — `connectionStateAtom` is what the
 * reconnecting banner reads. A scenario that restarts the server takes the
 * mark before the old one dies and waits here afterwards; asking the client
 * for anything sooner races its own backoff.
 */
export const awaitConnected = (
  states: Watch<ConnectionState>,
  after: ViewMark,
): Effect.Effect<void> =>
  states.awaitValue((state) => state.status === "connected", after).pipe(Effect.asVoid);

/** The credentials of one booted server, for `connect`. */
export const staticCredentials = (server: BootedServer): ConnectionCredentials => ({
  url: server.url,
  token: server.token,
  serverInstanceId: server.serverInstanceId,
});

// ── Commands ───────────────────────────────────────────────────

type CommandBody<T extends Command["type"]> = Omit<
  Extract<Command, { readonly type: T }>,
  "commandId" | "createdAt"
>;

/**
 * Builds a command with a fresh id and timestamp, so a scenario reads as the
 * user's intent rather than as bookkeeping.
 */
export const command = <T extends Command["type"]>(
  body: CommandBody<T> & { readonly type: T },
): Command =>
  ({
    commandId: makeCommandId(),
    createdAt: new Date().toISOString(),
    ...body,
  }) as unknown as Command;

// ── Where every scenario starts ────────────────────────────────

export interface OpenThread {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  /** The thread's own subscription, already folding. */
  readonly view: ThreadWatch;
}

/**
 * A project on the temp workspace, a thread on it, and a subscription.
 *
 * The subscription is opened here rather than by the caller so that no
 * scenario can dispatch its first turn before the stream is attached and then
 * assert against a snapshot that already contains the answer.
 */
export const openThread = (
  client: E2EClient,
  home: E2EHome,
  settings: ThreadSettingsPatch = {},
): Effect.Effect<OpenThread, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const projectId = makeProjectId();
    const threadId = makeThreadId();
    yield* client.send(
      command({ type: "project.create", projectId, name: "e2e", workspaceRoot: home.workspace }),
    );
    yield* client.send(
      command({
        type: "thread.create",
        threadId,
        projectId,
        settings: { model: E2E_MODEL, ...settings },
      }),
    );
    const view = yield* watchThread(client.rpc, threadId);
    return { projectId, threadId, view };
  });

/**
 * Starts a turn and answers with the mark at which it is on screen, so every
 * wait that follows is measured from the turn rather than from the thread's
 * whole history.
 */
export const startTurn = (
  client: E2EClient,
  open: OpenThread,
  input: {
    readonly text: string;
    readonly attachments?: ReadonlyArray<Attachment>;
    readonly mentions?: ReadonlyArray<string>;
    /** Cmd+Enter: queue behind the running turn instead of racing it. */
    readonly queued?: boolean;
  },
): Effect.Effect<ViewMark> =>
  client
    .send(
      command({
        type: "thread.turn.start",
        threadId: open.threadId,
        text: input.text,
        attachments: input.attachments ?? [],
        mentions: input.mentions ?? [],
        queued: input.queued ?? false,
      }),
    )
    .pipe(Effect.flatMap(open.view.markAfter));

/**
 * Answers every approval the thread raises, until the scope closes.
 *
 * Scenarios that are *about* the approval gate answer their cards by hand.
 * Every other scenario still has to get past it — a turn that edits a file
 * stops on a card whatever the test is really interested in — and this is the
 * user sitting there clicking Allow. Marks keep it from answering a card
 * twice, and the loop simply ends when the subscription does.
 */
export const autoApprove = (
  client: E2EClient,
  open: OpenThread,
  decision: "allow-once" | "allow-session" = "allow-once",
): Effect.Effect<void, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const from = yield* open.view.mark;
    const loop = (after: ViewMark): Effect.Effect<void> =>
      open.view
        .awaitAt((view) => view.pendingApproval !== null, after)
        .pipe(
          Effect.flatMap(({ value, next }) =>
            client
              .send(
                command({
                  type: "thread.approval.respond",
                  threadId: open.threadId,
                  requestId: value.pendingApproval!.requestId,
                  decision,
                }),
              )
              .pipe(Effect.andThen(loop(next))),
          ),
        );
    // The loop ends with the subscription, and a rejected answer — a card the
    // turn withdrew first — is not this fiber's business either.
    yield* Effect.forkScoped(Effect.ignore(loop(from)));
  });

// ── Reading a view ─────────────────────────────────────────────

/** Every assistant message in the view, joined — what the transcript says. */
export const assistantText = (view: ThreadDetailView): string =>
  view.items
    .filter((item) => item.kind === "assistant_message")
    .map((item) => item.text ?? "")
    .join(" ");

/**
 * True once the thread is free — the moment the composer re-enables.
 *
 * `currentTurnId` alone is not enough. A turn is *requested* before it is
 * *started*, and in that gap the thread carries no turn id while its status is
 * already `running`: a wait on the id alone is answered in the middle of a
 * turn that has not begun, and every assertion after it reads a half-built
 * timeline.
 */
export const isSettled = (view: ThreadDetailView): boolean =>
  view.currentTurnId === null &&
  view.status !== "running" &&
  view.status !== "waiting" &&
  view.pendingApproval === null &&
  view.pendingUserInput === null &&
  view.pendingPlan === null;

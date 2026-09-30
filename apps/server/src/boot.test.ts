/**
 * The composition root, built for real.
 *
 * Every other server test wires its own subset of the graph, so nothing used to
 * prove that the one `main.ts` ships holds together: that the handshake is
 * emitted, that the socket and the two loopback routes are mounted and guarded,
 * that a connector the user adds *after* boot is probed and opened by the
 * running app, and — the defect this file was written for — that a command
 * dispatched over RPC reaches the same engine the reactors listen to.
 *
 * Everything happens under a fresh `POSEIDON_HOME`, and nothing here spawns a
 * harness: no test touches a real install or spends an account.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  makeCommandId,
  makeConnectorInstanceId,
  makeProjectId,
  makeThreadId,
} from "@poseidon/contracts/ids";
import type { Command } from "@poseidon/contracts/orchestration";
import { PROTOCOL_VERSION } from "@poseidon/contracts/rpc";
import { defaultSettings } from "@poseidon/contracts/settings";
import type { ConnectorInstanceConfig } from "@poseidon/contracts/settings";
import { Connection, makeConnection } from "@poseidon/client-runtime/connection";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { boot, type BootedServer } from "./boot";
import { layer as sqliteLayer } from "./persistence/Sqlite";
import { SettingsStore } from "./rpc/services";

const MODEL = "stealth/ox-alpha";

interface Home {
  /** `POSEIDON_HOME` for this boot. */
  readonly poseidon: string;
  /** `HOME` for anything the connector might run, so nothing writes to the real one. */
  readonly cmd: string;
  /** A git repository to use as a project's workspace root. */
  readonly workspace: string;
}

const makeHome = (): Home => {
  const root = mkdtempSync(join(tmpdir(), "poseidon-boot-"));
  const workspace = join(root, "workspace");
  execFileSync("git", ["init", "--quiet", workspace], { stdio: "ignore" });
  return { poseidon: join(root, "home"), cmd: join(root, "cmd-home"), workspace };
};

/**
 * Writes the settings row `boot` will find. Without one the connector manager
 * treats the home as a fresh install and seeds a `cmd` instance that probes the
 * machine's real binary — or, failing that, `npx`.
 */
const seedSettings = (home: Home, connectors: ReadonlyArray<ConnectorInstanceConfig>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sqlite = Layer.succeedContext(
        yield* Layer.build(sqliteLayer({ filename: join(home.poseidon, "state.sqlite") })),
      );
      const store = Context.get(
        yield* Layer.build(SettingsStore.layer.pipe(Layer.provide(sqlite))),
        SettingsStore,
      );
      yield* store.update({ ...defaultSettings(), connectors });
    }),
  );

const connector = (home: Home, binaryPath: string): ConnectorInstanceConfig => ({
  connectorInstanceId: makeConnectorInstanceId(),
  kind: "cmd",
  displayName: "Command Code",
  enabled: true,
  // A `HOME` of its own, so nothing a probe runs can write to the real one.
  config: { binaryPath, extraEnv: { HOME: home.cmd } },
});

/** Boots the real graph in the test's scope and hands over the handshake. */
const booted = (home: Home) =>
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
  ).pipe(Effect.andThen(boot({ home: home.poseidon, dev: true, port: 0 })));

const client = (server: BootedServer) =>
  Layer.build(makeConnection({ url: server.url, token: server.token })).pipe(
    Effect.map((ctx) => Context.get(ctx, Connection)),
    Effect.flatMap((connection) => connection.client),
  );

const httpBase = (server: BootedServer) => server.url.replace(/^ws/, "http").replace(/\/ws$/, "");

const status = (url: string, init?: RequestInit) =>
  Effect.promise(() => fetch(url, init).then((response) => response.status));

describe("boot", () => {
  it.live("emits the handshake and answers server.hello over a real socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = makeHome();
        yield* seedSettings(home, []);
        const server = yield* booted(home);

        // Dev mode's handshake file is what the Vite plugin serves; it must
        // name the port that was actually bound, not the requested 0.
        const written: unknown = JSON.parse(
          readFileSync(join(home.poseidon, "dev", "connection.json"), "utf8"),
        );
        expect(written).toEqual(server);
        expect(server.url).not.toContain(":0/");

        const rpc = yield* client(server);
        const hello = yield* rpc["server.hello"]({});
        expect(hello.serverInstanceId).toBe(server.serverInstanceId);
        expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);

        // What the build ships is answered with no connector configured, and
        // without probing anything: the form comes from the definition alone.
        const described = yield* rpc["connectors.describe"]({});
        // Claude Code first, then Codex, then Command Code: the order is the
        // harness rank, which a fresh install is seeded in and routes by.
        expect(described.map((descriptor) => descriptor.kind)).toEqual(["claude", "codex", "cmd"]);
        expect(described[0]?.metadata.displayName).toBe("Claude Code");
        expect(described[0]?.configFields.map((field) => field.key)).toEqual([
          "binaryPath",
          "configDir",
          "defaultModel",
        ]);
        expect(described[1]?.metadata.displayName).toBe("Codex");
        expect(described[1]?.configFields.map((field) => field.key)).toEqual([
          "binaryPath",
          "codexHome",
          "defaultModel",
        ]);
        expect(described[2]?.metadata.displayName).toBe("Command Code");
        expect(described[2]?.configFields.map((field) => field.key)).toEqual([
          "binaryPath",
          "extraEnv",
          "defaultModel",
        ]);
      }),
    ),
  );

  it.live("writes the built-in plugins at boot and serves the plugin rpcs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = makeHome();
        yield* seedSettings(home, []);
        const server = yield* booted(home);
        const rpc = yield* client(server);

        // The Browser plugin is on disk only because the boot wrote it there.
        expect(
          existsSync(
            join(home.poseidon, "builtin-plugins", "browser", "skills", "browser", "SKILL.md"),
          ),
        ).toBe(true);

        const listed = yield* rpc["plugins.list"]({});
        expect(listed.globalDir).toBe(join(home.poseidon, "plugins"));
        expect(
          listed.plugins.map(({ pluginId, source, enabled }) => ({ pluginId, source, enabled })),
        ).toEqual([{ pluginId: "builtin:browser", source: "builtin", enabled: true }]);

        const off = yield* rpc["plugins.setEnabled"]({
          pluginId: "builtin:browser",
          enabled: false,
        });
        expect(off.plugins[0]?.enabled).toBe(false);
        expect((yield* rpc["settings.get"]({})).plugins).toEqual({ "builtin:browser": false });
      }),
    ),
  );

  it.live("guards the socket and both loopback routes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = makeHome();
        yield* seedSettings(home, []);
        const server = yield* booted(home);
        const base = httpBase(server);
        const post = { method: "POST", body: "{}" } satisfies RequestInit;

        expect(yield* status(`${base}/ws?token=wrong`)).toBe(401);
        expect(yield* status(`${base}/ws`)).toBe(401);
        expect(yield* status(`${base}/mcp`, post)).toBe(401);
        expect(yield* status(`${base}/hooks/pretooluse`, post)).toBe(401);

        // Each path is mounted once and reaches its own handler: a second
        // registration of either would shadow one of these answers.
        expect(yield* status(`${base}/healthz`)).toBe(200);
        expect(yield* status(`${base}/mcp`)).toBe(405);
        expect(yield* status(`${base}/nope`)).toBe(404);
      }),
    ),
  );

  it.live("never re-seeds a home whose connectors the user removed", () =>
    Effect.gen(function* () {
      // Seeding is for a first run only, and "first run" is "no settings row",
      // not "no connectors": a user who deletes every connector has a row by
      // then. Guarding on the empty list instead put a `cmd` entry back on the
      // next start, which is what one owner of the connector lifecycle fixes.
      const home = makeHome();
      yield* seedSettings(home, []);

      const connectorsAfterBoot = Effect.scoped(
        Effect.gen(function* () {
          const server = yield* booted(home);
          return yield* (yield* client(server))["connectors.list"]({});
        }),
      );

      expect(yield* connectorsAfterBoot).toEqual([]);
      // The second boot is the one that used to resurrect it, over the very
      // same database the first one left behind.
      expect(yield* connectorsAfterBoot).toEqual([]);
    }),
  );

  it.live("dispatches into the same engine the reactors listen to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The graph used to be assembled with three separate `Layer.build`
        // calls, and `Layer.build` memoizes per call — so `engine` and
        // `manager`, which both the services and the server reach, were each
        // constructed twice. The database was shared, so every read agreed and
        // nothing looked wrong; the PubSubs were not, so the reactors that hang
        // off `engine.subscribeEvents` were listening to an engine no command
        // was ever dispatched through.
        //
        // The browser teardown reactor is that wiring, seen from outside: it
        // subscribes inside the services and fires on `thread.deleted`, which
        // only ever arrives through the RPC handlers' engine. A second element
        // on the session's state stream means the two are one.
        const home = makeHome();
        yield* seedSettings(home, []);
        const server = yield* booted(home);
        const rpc = yield* client(server);

        const projectId = makeProjectId();
        const threadId = makeThreadId();
        const dispatch = (command: Command) => rpc["orchestration.dispatch"]({ command });
        yield* dispatch({
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          type: "project.create",
          projectId,
          name: "boot",
          workspaceRoot: home.workspace,
        });
        yield* dispatch({
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          type: "thread.create",
          threadId,
          projectId,
          settings: { model: MODEL },
        });

        // Opening the subscription is what creates the session record the
        // reactor later tears down; no browser is launched until a tool call.
        const states = yield* Queue.unbounded<unknown>();
        yield* Stream.runForEach(rpc["browser.subscribe"]({ threadId }), (state) =>
          Queue.offer(states, state),
        ).pipe(Effect.forkChild);
        // The session's own initial state, taken before the delete is
        // dispatched: the subscription is attached by the time it arrives, so
        // the assertion below cannot pass on a replay of what was already there.
        yield* Queue.take(states).pipe(Effect.timeout("30 seconds"));

        yield* dispatch({
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          type: "thread.delete",
          threadId,
        });

        // The teardown's own write. With two engines nothing ever publishes it.
        expect(yield* Queue.take(states).pipe(Effect.timeout("30 seconds"))).toMatchObject({
          threadId,
          status: "stopped",
        });
      }),
    ),
  );

  it.live("shuts down while a client is still connected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // `http.Server.close()` waits for every open connection to end by
        // itself, and a WebSocket never does. With a renderer attached the
        // server therefore never finished closing and the scope that owned it
        // hung — which nothing noticed while the only shutdown in the product
        // was the supervisor killing the process, but `boot`'s contract is
        // that closing its scope shuts the server down.
        //
        // The client is built in the *outer* scope on purpose. Built inside,
        // it is torn down first and hangs up the socket on its way out, which
        // is the one arrangement that always worked.
        const home = makeHome();
        yield* seedSettings(home, []);
        const outer = yield* Effect.scope;
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* booted(home);
            // The connection is built in the *outer* scope, so its socket is
            // still open when the server's scope closes. Built inside, it is
            // torn down first and hangs up on its way out — the one
            // arrangement that always worked.
            const rpc = yield* client(server).pipe(Scope.provide(outer));
            const hello = yield* rpc["server.hello"]({});
            expect(hello.serverInstanceId).toBe(server.serverInstanceId);
            return server;
          }),
        );
        // Reaching here at all is the assertion: a server that cannot close
        // never returns from the line above. That the port is free again is
        // what the second boot on the same home shows.
        const second = yield* booted(home);
        expect(second.serverInstanceId).not.toBe(first.serverInstanceId);
      }),
    ),
  );

  it.live("probes and opens a connector added after boot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = makeHome();
        yield* seedSettings(home, []);
        const server = yield* booted(home);
        const rpc = yield* client(server);

        // The settings page's own path: write the instance, then refresh. The
        // defect this covers is an entry the running app never picks up — one
        // that stays "Probing…" forever, or is configured but never opened, so
        // the first turn on it fails with `NoConnector`.
        //
        // What the opened instance is *lent* is pinned one level down, where a
        // stub host can be inspected: connector-manager.test.ts's "an instance
        // re-enabled after boot is lent the running app's endpoints". Nothing
        // here drives a real turn — the binary below does not exist, so no
        // child process runs and no account is spent; the Command Code CLI's
        // own behaviour is covered by the connector-cmd suite against it.
        const instance = connector(home, join(home.poseidon, "no-such-cmd"));
        yield* rpc["settings.update"]({ patch: { connectors: [instance] } });

        const listed = yield* rpc["connectors.list"]({ refresh: true });
        expect(listed).toHaveLength(1);
        expect(listed[0]!.connectorInstanceId).toBe(instance.connectorInstanceId);
        // Probed by the running app: a missing binary is an answer, "probing"
        // would mean nothing had run the probe at all.
        expect(listed[0]!.probe.status).toBe("error");
        // Opened, not merely configured: capabilities come from the instance.
        expect(listed[0]!.capabilities).not.toBeNull();
      }),
    ),
  );
});

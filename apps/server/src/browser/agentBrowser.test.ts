/**
 * The CLI wrapper: the session name, the env one session's invocations run
 * with, the bridge handoff, the envelope parse, and the daemon's end — the
 * namespace every session runs in, the boot `close --all`, and a session's
 * shutdown that kills a daemon which will not close. Every envelope a runner
 * answers with here is one the real CLI printed (`cli-reap`).
 */

import { spawn } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BRIDGE_ENV, BRIDGE_KEY_ENV, mintLaunchKey } from "@poseidon/shared/browserBridge";
import { readManifest } from "@poseidon/testkit/recording";

import {
  AGENT_BROWSER_MISSING_MESSAGE,
  agentBrowserMissingMessage,
  AgentBrowser,
  BROWSER_DISABLED_MESSAGE,
  browserEnv,
  daemonPidPath,
  decodeResult,
  ensureOwnConfig,
  launchEnvFor,
  makeAgentBrowser,
  modeFor,
  namespaceFor,
  OWNED_CHROME_ARGS,
  ownConfigPath,
  readBridgeConfig,
  sessionEnvFor,
  sessionNameFor,
  takeBridgeConfig,
  TIMEOUT_CODE,
  type ChildResult,
  type ChildRunner,
} from "./agentBrowser";

const KEY = "a".repeat(64);
const BASE = "ws://127.0.0.1:47000";

/** A runner that records what it was asked to run and answers one envelope. */
const capture = (envelope: unknown = { success: true, data: {}, error: null }) => {
  const runs: Array<{ args: ReadonlyArray<string>; env: Record<string, string> }> = [];
  const run: ChildRunner = (_binary, args, options) =>
    Effect.sync(() => {
      runs.push({ args, env: options.env });
      return { stdout: JSON.stringify(envelope), stderr: "", error: null };
    });
  return { runs, run };
};

describe("agentBrowser", () => {
  it("tells the user exactly what to run when the binary is missing", () => {
    // The pane keys its install prompt off this opening clause and prints the
    // same commands. In-app drives the pane's webviews: no Chrome download.
    const inApp = agentBrowserMissingMessage("in-app");
    const owned = agentBrowserMissingMessage("owned-chromium");
    for (const message of [inApp, owned]) {
      expect(message.startsWith(AGENT_BROWSER_MISSING_MESSAGE)).toBe(true);
      expect(message).toContain("npm install -g agent-browser");
    }
    expect(inApp).not.toContain("agent-browser install");
    expect(owned).toContain("`agent-browser install`");
  });

  it.effect("fails every call with the mode's install sentence when the binary is missing", () =>
    Effect.gen(function* () {
      const inApp = makeAgentBrowser({
        binary: null,
        version: null,
        bridge: { base: BASE, key: KEY },
      });
      const failed = yield* Effect.flip(inApp.session("t-1").exec(["get", "title"]));
      expect(failed.message).toBe(agentBrowserMissingMessage("in-app"));
      const owned = makeAgentBrowser({ binary: null, version: null, bridge: null });
      const ownedFailed = yield* Effect.flip(owned.session("t-1").exec(["get", "title"]));
      expect(ownedFailed.message).toBe(agentBrowserMissingMessage("owned-chromium"));
    }),
  );

  it("names a thread's daemon session", () => {
    // Hashed, so the daemon's socket path fits the 103-byte limit whatever
    // the id; stable, so every call for the thread reaches the same daemon.
    expect(sessionNameFor("t-1")).toMatch(/^ade-[0-9a-f]{12}$/);
    expect(sessionNameFor("t-1")).toBe(sessionNameFor("t-1"));
    expect(sessionNameFor("t-2")).not.toBe(sessionNameFor("t-1"));
  });

  it("gives every session an idle timeout", () => {
    // The safety net behind `close`: a daemon the server never closed (it
    // crashed) still reaps itself.
    expect(sessionEnvFor("poseidon-x", "/p/agent-browser.json").AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe(
      "300000",
    );
  });

  it("points every run at our own config, never the user's or the project's", () => {
    // ~/.agent-browser/config.json can set executablePath, plugins, initScripts
    // and the very knobs the env allowlist drops; naming a file skips it.
    expect(sessionEnvFor("poseidon-x", "/p/agent-browser.json").AGENT_BROWSER_CONFIG).toBe(
      "/p/agent-browser.json",
    );
    expect(ownConfigPath("/Users/someone/.poseidon")).toBe(
      "/Users/someone/.poseidon/agent-browser.json",
    );
  });

  it("hands the child an allowlist, not the server's whole environment", () => {
    // agent-browser is a third-party CLI with a plugin system and an auth
    // vault, and it is the component that then visits untrusted pages.
    const env = browserEnv(
      {
        HOME: "/Users/someone",
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.internal:3128",
        DISPLAY: ":0",
        LC_ALL: "en_GB.UTF-8",
        ANTHROPIC_API_KEY: "sk-test-1234",
        OPENAI_API_KEY: "sk-test-5678",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        GITHUB_TOKEN: "ghp_test",
        COMMAND_CODE_API_KEY: "cc-secret",
        POSEIDON_SERVER_TOKEN: "server-token",
        POSEIDON_HOME: "/Users/someone/.poseidon",
      },
      sessionEnvFor("poseidon-x", "/Users/someone/.poseidon/agent-browser.json"),
    );

    expect(env).toEqual({
      HOME: "/Users/someone",
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.internal:3128",
      DISPLAY: ":0",
      LC_ALL: "en_GB.UTF-8",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "300000",
      AGENT_BROWSER_NAMESPACE: "poseidon-x",
      AGENT_BROWSER_CONFIG: "/Users/someone/.poseidon/agent-browser.json",
    });
  });

  it("drops the operator's own AGENT_BROWSER_* and CHROME_*", () => {
    // Each of these redirects or loosens the child: another browser to drive,
    // one to go looking for, local files for pages to read.
    const env = browserEnv({
      PATH: "/usr/bin",
      AGENT_BROWSER_CDP: "ws://127.0.0.1:9222/devtools/browser/x",
      AGENT_BROWSER_AUTO_CONNECT: "1",
      AGENT_BROWSER_ALLOW_FILE_ACCESS: "1",
      AGENT_BROWSER_CONFIG: "/tmp/evil.json",
      CHROME_PATH: "/tmp/not-chrome",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("will not let the extra env smuggle a name the list refuses", () => {
    const env = browserEnv({}, { ANTHROPIC_API_KEY: "sk-test", AGENT_BROWSER_PROFILE: "work" });
    expect(env).toEqual({ AGENT_BROWSER_PROFILE: "work" });
  });

  describe("the bridge handoff", () => {
    it("reads a bridge, the kill switch, or nothing", () => {
      expect(readBridgeConfig({ [BRIDGE_ENV]: BASE, [BRIDGE_KEY_ENV]: KEY })).toEqual({
        base: BASE,
        key: KEY,
      });
      expect(readBridgeConfig({ [BRIDGE_ENV]: "disabled" })).toBe("disabled");
      expect(readBridgeConfig({})).toBeNull();
      expect(modeFor({ base: BASE, key: KEY })).toBe("in-app");
      expect(modeFor("disabled")).toBe("disabled");
      expect(modeFor(null)).toBe("owned-chromium");
    });

    it("treats an unusable handoff as disabled, never as no desktop", () => {
      // `null` would mean owned Chromium: a desktop quietly driving a headless
      // browser the user cannot see.
      for (const env of [
        { [BRIDGE_ENV]: BASE },
        { [BRIDGE_ENV]: BASE, [BRIDGE_KEY_ENV]: "short" },
        { [BRIDGE_ENV]: "ws://10.0.0.5:47000", [BRIDGE_KEY_ENV]: KEY },
        { [BRIDGE_ENV]: "ws://127.0.0.1", [BRIDGE_KEY_ENV]: KEY },
      ]) {
        expect(readBridgeConfig(env)).toBe("disabled");
      }
    });

    it("takes the launch key out of the environment it read it from", () => {
      const env: Record<string, string | undefined> = {
        [BRIDGE_ENV]: BASE,
        [BRIDGE_KEY_ENV]: KEY,
        POSEIDON_HOME: "/tmp/home",
      };
      expect(takeBridgeConfig(env)).toEqual({ base: BASE, key: KEY });
      expect(env).toEqual({ POSEIDON_HOME: "/tmp/home" });
    });

    it.effect("the layer removes the handoff from process.env", () =>
      Effect.gen(function* () {
        const key = mintLaunchKey();
        const saved = { ...process.env };
        process.env[BRIDGE_ENV] = BASE;
        process.env[BRIDGE_KEY_ENV] = key;
        // A binary that is not there: the probe fails fast and harmlessly.
        process.env.POSEIDON_AGENT_BROWSER = "/nonexistent/agent-browser";
        try {
          const agentBrowser = yield* Effect.scoped(
            Layer.build(AgentBrowser.layer).pipe(
              Effect.map((context) => Context.get(context, AgentBrowser)),
            ),
          );
          expect(agentBrowser.mode).toBe("in-app");
          expect(process.env[BRIDGE_ENV]).toBeUndefined();
          expect(process.env[BRIDGE_KEY_ENV]).toBeUndefined();
          expect(JSON.stringify(process.env)).not.toContain(key);
        } finally {
          for (const name of [BRIDGE_ENV, BRIDGE_KEY_ENV, "POSEIDON_AGENT_BROWSER"]) {
            delete process.env[name];
            if (saved[name] !== undefined) process.env[name] = saved[name];
          }
        }
      }),
    );
  });

  describe("a session", () => {
    it.effect("writes our own config before every run and points the child at it", () =>
      Effect.gen(function* () {
        const { runs, run } = capture();
        const order: Array<string> = [];
        const agentBrowser = makeAgentBrowser({
          binary: "agent-browser",
          version: "0.38.1",
          bridge: null,
          env: { PATH: "/usr/bin", POSEIDON_HOME: "/tmp/poseidon-home" },
          prepare: (path) => Effect.sync(() => void order.push(`prepare ${path}`)),
          run: (binary, args, options) =>
            Effect.andThen(
              Effect.sync(() => void order.push("run")),
              run(binary, args, options),
            ),
        });
        yield* agentBrowser.session("thread-1").exec(["get", "title"]);
        yield* agentBrowser.session("thread-1").exec(["get", "url"]);

        const path = "/tmp/poseidon-home/agent-browser.json";
        expect(order).toEqual([`prepare ${path}`, "run", `prepare ${path}`, "run"]);
        expect(runs.map((entry) => entry.env.AGENT_BROWSER_CONFIG)).toEqual([path, path]);
      }),
    );

    it.effect("keeps our config at {} whatever was written over it", () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "poseidon-ab-config-"));
        const path = NodePath.join(dir, "home", "agent-browser.json");
        try {
          yield* ensureOwnConfig(path);
          expect(NodeFS.readFileSync(path, "utf8")).toBe("{}\n");
          NodeFS.writeFileSync(path, JSON.stringify({ executablePath: "/tmp/not-chrome" }));
          yield* ensureOwnConfig(path);
          expect(JSON.parse(NodeFS.readFileSync(path, "utf8"))).toEqual({});
          expect(NodeFS.readdirSync(NodePath.dirname(path))).toEqual(["agent-browser.json"]);
        } finally {
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("in-app, carries its bridge URL in the child's env and never in argv", () =>
      Effect.gen(function* () {
        const { runs, run } = capture();
        const agentBrowser = makeAgentBrowser({
          binary: "agent-browser",
          version: "0.38.1",
          bridge: { base: BASE, key: KEY },
          env: {
            PATH: "/usr/bin",
            AGENT_BROWSER_CDP: "ws://127.0.0.1:9222/devtools/browser/operator",
            AGENT_BROWSER_ALLOW_FILE_ACCESS: "1",
          },
          run,
        });
        yield* agentBrowser.session("thread-1").exec(["get", "title"]);

        const [only] = runs;
        expect(only?.args).toEqual([
          "--session",
          sessionNameFor("thread-1"),
          "--json",
          "get",
          "title",
        ]);
        expect(only?.env.AGENT_BROWSER_CDP).toMatch(
          /^ws:\/\/127\.0\.0\.1:47000\/cdp\/thread-1\/[0-9a-f]{64}$/,
        );
        // The operator's own values are gone, not merely overridden.
        expect(only?.env.AGENT_BROWSER_ALLOW_FILE_ACCESS).toBeUndefined();
        expect(only?.env.AGENT_BROWSER_CDP).not.toContain("9222");
      }),
    );

    it.effect("owned, runs with no CDP endpoint at all", () =>
      Effect.gen(function* () {
        const { runs, run } = capture();
        const agentBrowser = makeAgentBrowser({
          binary: "agent-browser",
          version: "0.38.1",
          bridge: null,
          env: { PATH: "/usr/bin", AGENT_BROWSER_CDP: "9222" },
          run,
        });
        expect(agentBrowser.mode).toBe("owned-chromium");
        yield* agentBrowser.session("thread-1").exec(["open"]);
        expect(runs[0]?.env.AGENT_BROWSER_CDP).toBeUndefined();
      }),
    );

    it("gives only owned Chromium's non-close commands the launch args", () => {
      const owned = { AGENT_BROWSER_ARGS: OWNED_CHROME_ARGS };
      expect(OWNED_CHROME_ARGS.split(",")).toContain("--use-mock-keychain");
      expect(OWNED_CHROME_ARGS).not.toContain("headless");
      expect(launchEnvFor(null, ["open"])).toEqual(owned);
      expect(launchEnvFor(null, ["get", "title"])).toEqual(owned);
      expect(launchEnvFor(null, ["close"])).toEqual({});
      for (const bridge of ["disabled", { base: BASE, key: KEY }] as const) {
        expect(launchEnvFor(bridge, ["open"])).toEqual({});
        expect(launchEnvFor(bridge, ["close"])).toEqual({});
      }
    });

    it.effect("owned, launches its Chrome with a mock keychain through the env alone", () =>
      Effect.gen(function* () {
        const { runs, run } = capture();
        const agentBrowser = makeAgentBrowser({
          binary: "agent-browser",
          version: "0.38.1",
          bridge: null,
          env: {
            PATH: "/usr/bin",
            AGENT_BROWSER_ARGS: "--remote-debugging-port=9222",
            AGENT_BROWSER_HEADED: "1",
          },
          run,
        });
        const session = agentBrowser.session("thread-1");
        yield* session.exec(["open"]);
        yield* session.shutdown;

        const [open, close] = runs;
        expect(open?.args).toEqual(["--session", sessionNameFor("thread-1"), "--json", "open"]);
        // Ours replaces the operator's, and they cannot turn headless off.
        expect(open?.env.AGENT_BROWSER_ARGS).toBe(OWNED_CHROME_ARGS);
        expect(open?.env.AGENT_BROWSER_HEADED).toBeUndefined();
        // Args make the CLI launch before any command: `close` goes without.
        expect(close?.args.slice(-1)).toEqual(["close"]);
        expect(close?.env.AGENT_BROWSER_ARGS).toBeUndefined();
      }),
    );

    it.effect("in-app, passes no launch args", () =>
      Effect.gen(function* () {
        const { runs, run } = capture();
        const agentBrowser = makeAgentBrowser({
          binary: "agent-browser",
          version: "0.38.1",
          bridge: { base: BASE, key: KEY },
          env: { PATH: "/usr/bin", AGENT_BROWSER_ARGS: "--use-mock-keychain" },
          run,
        });
        yield* agentBrowser.session("thread-1").exec(["open"]);
        expect(runs[0]?.env.AGENT_BROWSER_ARGS).toBeUndefined();
      }),
    );

    it.live("owned, reaps without launch args", () =>
      Effect.gen(function* () {
        const { runs, run } = reapRunner();
        const { home } = homeWithLeftovers("poseidon-ours");
        const agentBrowser = makeAgentBrowser({
          binary: "agent-browser",
          version: "0.38.1",
          bridge: null,
          env: { HOME: home, PATH: "/usr/bin" },
          namespace: "poseidon-ours",
          run,
        });
        yield* agentBrowser.reap;
        NodeFS.rmSync(home, { recursive: true, force: true });
        expect(runs[0]?.args).toEqual(["--json", "close", "--all"]);
        expect(runs.some((entry) => entry.args.includes("list"))).toBe(true);
        for (const entry of runs) expect(entry.env.AGENT_BROWSER_ARGS).toBeUndefined();
      }),
    );

    it.effect("disabled, answers the kill switch and runs nothing", () =>
      Effect.gen(function* () {
        const { runs, run } = capture();
        const agentBrowser = makeAgentBrowser({
          binary: "agent-browser",
          version: "0.38.1",
          bridge: "disabled",
          run,
        });
        const failed = yield* agentBrowser
          .session("thread-1")
          .exec(["tab", "list"])
          .pipe(Effect.flip);
        expect(failed.message).toBe(BROWSER_DISABLED_MESSAGE);
        expect(runs).toEqual([]);
      }),
    );
  });

  it.effect("classifies the real tab_gone envelope, which carries no data.code", () =>
    Effect.gen(function* () {
      const manifest = readManifest<{
        steps: ReadonlyArray<{ argv?: ReadonlyArray<string>; envelope?: { success: boolean } }>;
      }>("agent-browser", "cli-tab-gone");
      const gone = manifest.steps.find((step) => step.envelope?.success === false);
      const failed = yield* decodeResult("agent-browser get title", {
        stdout: JSON.stringify(gone?.envelope),
        stderr: "",
        error: "Command failed",
      }).pipe(Effect.flip);
      expect(failed.code).toBe("tab_gone");
      expect(failed.data).toMatchObject({ lastUrl: "http://127.0.0.1:<SITE_PORT>/" });
    }),
  );
});

/**
 * The real CLI's envelopes for one command of the `cli-reap` recording, in
 * the order it answered them: `session list` before and after `close --all`.
 */
const reapEnvelopes = (argv: ReadonlyArray<string>): ReadonlyArray<unknown> => {
  const manifest = readManifest<{
    steps: ReadonlyArray<{ argv?: ReadonlyArray<string>; envelope?: unknown }>;
  }>("agent-browser", "cli-reap");
  const steps = manifest.steps.filter((entry) => entry.argv?.join(" ") === argv.join(" "));
  if (steps.length === 0) throw new Error(`cli-reap recorded no \`${argv.join(" ")}\``);
  return steps.map((step) => step.envelope);
};

const reapEnvelope = (argv: ReadonlyArray<string>): unknown => reapEnvelopes(argv)[0];

/**
 * A runner that answers each command with its next `cli-reap` envelope (the
 * last one again once they run out), or runs out of time for the commands in
 * `hang` — what `execFile` reports once it has killed a child whose daemon
 * never answered.
 */
const reapRunner = (hang: ReadonlyArray<string> = []) => {
  const runs: Array<{ args: ReadonlyArray<string>; env: Record<string, string> }> = [];
  const answered = new Map<string, number>();
  const run: ChildRunner = (_binary, args, options) =>
    Effect.sync((): ChildResult => {
      runs.push({ args, env: options.env });
      const argv = args.slice(args.indexOf("--json") + 1);
      const command = argv.join(" ");
      if (hang.includes(command)) {
        return { stdout: "", stderr: "", error: "Command failed", timedOut: true };
      }
      const envelopes = reapEnvelopes(argv);
      const index = answered.get(command) ?? 0;
      answered.set(command, index + 1);
      const envelope = envelopes[Math.min(index, envelopes.length - 1)];
      return { stdout: JSON.stringify(envelope), stderr: "", error: null };
    });
  return { runs, run };
};

/** A home holding a stale file in `namespace`, as `close` leaves behind. */
const homeWithLeftovers = (namespace: string) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "poseidon-reap-"));
  const run = NodePath.join(home, ".agent-browser", "namespaces", namespace, "run");
  NodeFS.mkdirSync(run, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(run, "ade-000000000000.config"), "0");
  return { home, dir: NodePath.dirname(run) };
};

describe("the daemon's namespace and end", () => {
  it("names one namespace per Poseidon home", () => {
    const home = namespaceFor("/Users/someone/.poseidon");
    expect(home).toMatch(/^poseidon-[0-9a-f]{8}$/);
    expect(namespaceFor("/Users/someone/.poseidon")).toBe(home);
    expect(namespaceFor("/tmp/poseidon-f8")).not.toBe(home);
  });

  it("keeps a thread's daemon socket inside the 103-byte limit", () => {
    // The layout `session info` reported in cli-reap, for a macOS home with a
    // longish user name and a real thread id.
    const socket = daemonPidPath(
      "/Users/someone.lastname",
      namespaceFor("/Users/someone.lastname/.poseidon"),
      sessionNameFor("01a0d127-a895-7000-874c-44c1cdb57ff0"),
    ).replace(/\.pid$/, ".sock");
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
  });

  it("follows POSEIDON_HOME by default", () => {
    const agentBrowser = makeAgentBrowser({
      binary: "agent-browser",
      version: "0.38.1",
      bridge: null,
      env: { POSEIDON_HOME: "/tmp/poseidon-f8" },
    });
    expect(agentBrowser.namespace).toBe(namespaceFor("/tmp/poseidon-f8"));
  });

  it("finds a daemon's pid where the recorded session info says it lives", () => {
    const info = reapEnvelope(["session", "info"]) as {
      data: { socketDir: string; session: string; namespace: string; pid: number };
    };
    expect(info.data.pid).toBeGreaterThan(1);
    expect(daemonPidPath("<HOME>", info.data.namespace, info.data.session)).toBe(
      `${info.data.socketDir}/${info.data.session}.pid`,
    );
  });

  it.effect("runs every session of every thread in our namespace", () =>
    Effect.gen(function* () {
      for (const bridge of [{ base: BASE, key: KEY }, null] as const) {
        const { runs, run } = capture();
        const agentBrowser = makeAgentBrowser({
          binary: "agent-browser",
          version: "0.38.1",
          bridge,
          env: { PATH: "/usr/bin", AGENT_BROWSER_NAMESPACE: "the-users-own" },
          namespace: "poseidon-ours",
          run,
        });
        yield* agentBrowser.session("thread-1").exec(["get", "title"]);
        yield* agentBrowser.session("thread-2").exec(["tab", "list"]);
        yield* agentBrowser.session("thread-2").shutdown;
        expect(runs).toHaveLength(3);
        for (const entry of runs) {
          expect(entry.env.AGENT_BROWSER_NAMESPACE).toBe("poseidon-ours");
        }
      }
    }),
  );

  it.live("reaps with close --all scoped to our namespace, and waits for the daemons to go", () =>
    Effect.gen(function* () {
      const { runs, run } = reapRunner();
      const killed: Array<string> = [];
      const { home, dir } = homeWithLeftovers("poseidon-ours");
      const agentBrowser = makeAgentBrowser({
        binary: "agent-browser",
        version: "0.38.1",
        bridge: { base: BASE, key: KEY },
        env: { HOME: home, PATH: "/usr/bin", AGENT_BROWSER_NAMESPACE: "the-users-own" },
        namespace: "poseidon-ours",
        run,
        kill: (session) => Effect.sync(() => void killed.push(session)),
      });
      yield* agentBrowser.reap;

      // No session and no bridge: it is the namespace that bounds `--all`.
      expect(runs[0]?.args).toEqual(["--json", "close", "--all"]);
      for (const entry of runs) {
        expect(entry.env.AGENT_BROWSER_NAMESPACE).toBe("poseidon-ours");
        expect(entry.env.AGENT_BROWSER_CDP).toBeUndefined();
      }
      // The recorded list still named the daemon right after `close --all`,
      // and was empty the next time: it exited by itself, so nothing was
      // killed, and the namespace's leftovers are gone.
      expect(runs.map((entry) => entry.args.slice(1).join(" "))).toEqual([
        "close --all",
        "session list",
        "session list",
        "session list",
      ]);
      expect(killed).toEqual([]);
      expect(NodeFS.existsSync(dir)).toBe(false);
      NodeFS.rmSync(home, { recursive: true, force: true });
    }),
  );

  it.live("a reap that times out kills each listed daemon", () =>
    Effect.gen(function* () {
      const { runs, run } = reapRunner(["close --all"]);
      const killed: Array<string> = [];
      const { home } = homeWithLeftovers("poseidon-ours");
      const agentBrowser = makeAgentBrowser({
        binary: "agent-browser",
        version: "0.38.1",
        bridge: "disabled",
        env: { HOME: home, PATH: "/usr/bin" },
        namespace: "poseidon-ours",
        run,
        kill: (session) => Effect.sync(() => void killed.push(session)),
      });
      // Orphans from an in-app run are reaped even with the bridge off now.
      yield* agentBrowser.reap;
      expect(runs.map((entry) => entry.args.slice(1).join(" ")).slice(0, 2)).toEqual([
        "close --all",
        "session list",
      ]);
      expect(killed).toEqual(["rec-cli-reap"]);
      NodeFS.rmSync(home, { recursive: true, force: true });
    }),
  );

  it.effect("a reap with no binary runs nothing", () =>
    Effect.gen(function* () {
      const { runs, run } = reapRunner();
      yield* makeAgentBrowser({ binary: null, version: null, bridge: null, run }).reap;
      expect(runs).toEqual([]);
    }),
  );

  it.effect("a command that runs out of time fails as a timeout", () =>
    Effect.gen(function* () {
      const { run } = reapRunner(["screenshot /tmp/shot.png"]);
      const failed = yield* makeAgentBrowser({
        binary: "agent-browser",
        version: "0.38.1",
        bridge: { base: BASE, key: KEY },
        run,
      })
        .session("thread-1")
        .exec(["screenshot", "/tmp/shot.png"], { timeoutMs: 15_000 })
        .pipe(Effect.flip);
      expect(failed._tag === "AgentBrowserError" ? failed.code : null).toBe(TIMEOUT_CODE);
      expect(failed.message).toContain("timed out after 15s");
    }),
  );

  it.effect("shutdown closes, and kills only a daemon that will not close", () =>
    Effect.gen(function* () {
      const killed: Array<string> = [];
      const kill = (session: string) => Effect.sync(() => void killed.push(session));
      const closeEnvelope = readManifest<{
        steps: ReadonlyArray<{ argv?: ReadonlyArray<string>; envelope?: unknown }>;
      }>("agent-browser", "cli-attach").steps.find(
        (step) => step.argv?.join(" ") === "close",
      )?.envelope;

      const { runs, run } = capture(closeEnvelope);
      yield* makeAgentBrowser({
        binary: "agent-browser",
        version: "0.38.1",
        bridge: { base: BASE, key: KEY },
        run,
        kill,
      }).session("thread-1").shutdown;
      expect(runs[0]?.args).toEqual(["--session", sessionNameFor("thread-1"), "--json", "close"]);
      expect(killed).toEqual([]);

      const hung = reapRunner(["close"]);
      yield* makeAgentBrowser({
        binary: "agent-browser",
        version: "0.38.1",
        bridge: { base: BASE, key: KEY },
        run: hung.run,
        kill,
      }).session("thread-1").shutdown;
      expect(killed).toEqual([sessionNameFor("thread-1")]);
    }),
  );

  describe.skipIf(process.platform === "win32")("the kill behind a hung close", () => {
    /** A home whose namespace holds thread-1's pid file naming `pid`. */
    const homeWithPid = (pid: number) => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "poseidon-kill-"));
      const pidPath = daemonPidPath(home, "poseidon-ours", sessionNameFor("thread-1"));
      NodeFS.mkdirSync(NodePath.dirname(pidPath), { recursive: true });
      NodeFS.writeFileSync(pidPath, `${pid}`);
      return home;
    };

    const shutdownHung = (home: string) =>
      makeAgentBrowser({
        binary: "agent-browser",
        version: "0.38.1",
        bridge: { base: BASE, key: KEY },
        env: { HOME: home, PATH: process.env.PATH },
        namespace: "poseidon-ours",
        run: reapRunner(["close"]).run,
      }).session("thread-1").shutdown;

    it.live("never kills a reused pid that is not agent-browser", () =>
      Effect.gen(function* () {
        // This test's own process: a stale pid file naming it must not be
        // taken at its word.
        const home = homeWithPid(process.pid);
        yield* shutdownHung(home);
        expect(() => process.kill(process.pid, 0)).not.toThrow();
        NodeFS.rmSync(home, { recursive: true, force: true });
      }),
    );

    it.live("tolerates a missing pid file", () =>
      Effect.gen(function* () {
        const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "poseidon-kill-"));
        yield* shutdownHung(home);
        NodeFS.rmSync(home, { recursive: true, force: true });
      }),
    );

    it.live("SIGKILLs the process the pid file names when it is agent-browser", () =>
      Effect.gen(function* () {
        // A process whose name is agent-browser's — a copy of `sleep`, not a
        // CLI: nothing here stands in for what agent-browser answers.
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "poseidon-kill-"));
        const standIn = NodePath.join(dir, "agent-browser-daemon");
        NodeFS.copyFileSync("/bin/sleep", standIn);
        const child = spawn(standIn, ["30"], { stdio: "ignore" });
        const exited = new Promise<NodeJS.Signals | null>((resolve) =>
          child.on("exit", (_code, signal) => resolve(signal)),
        );
        const home = homeWithPid(child.pid ?? 0);
        yield* shutdownHung(home);
        const signal = yield* Effect.promise(() => exited);
        expect(signal).toBe("SIGKILL");
        NodeFS.rmSync(home, { recursive: true, force: true });
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
    );
  });
});

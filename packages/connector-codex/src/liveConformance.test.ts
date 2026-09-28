/**
 * The conformance suite against the operator's REAL Codex CLI.
 *
 * Every other test of this connector replays a recording. This one spends the
 * operator's account, so it is opt-in and never runs in the gate:
 *
 *     POSEIDON_LIVE_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
 *       pnpm -F @poseidon/connector-codex vitest run src/liveConformance.test.ts
 *
 * What it proves that a replay cannot: that the CLI installed today is signed
 * in and still speaks every app-server method this connector sends or handles
 * (read from the CLI's own `generate-json-schema --experimental`), that a real
 * model's notifications still map without falling through to
 * `event.unmapped`, that its approval requests still reach Poseidon's gate,
 * and that plan mode still hands a plan over. When the CLI changes under us,
 * this is what says so; a recording it disagrees with is stale, and is
 * recorded again rather than edited.
 *
 * Kept cheap: the CLI's default model (the thread names none), one-line
 * prompts, one small file write allowed once. Codex has no turn or budget cap,
 * so the prompts are what keep each turn short.
 *
 * `HOME` and `CODEX_HOME` are the operator's own, because that is where the
 * CLI's login lives; `POSEIDON_LIVE_CODEX_HOME` points the instance at a
 * separate account instead (`codexHome`). The workspace is a throwaway git
 * repo under `/tmp/poseidon-codex`. `POSEIDON_LIVE_CODEX_DEBUG=1` prints the
 * connector's log lines and every event type of the turns this file drives.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { runConnectorConformance } from "@poseidon/connector-sdk/conformance";
import type { ConnectorServices } from "@poseidon/connector-sdk/definition";
import type { SessionHandle } from "@poseidon/connector-sdk/sessionHandle";
import { makeStreamCollector, type StreamCollector } from "@poseidon/connector-sdk/streamCollector";
import { makeConnectorInstanceId, makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { vi } from "vitest";

import { answerCards } from "../test/scenario";
import { testServices } from "../test/services";
import { resolveBinary } from "./binary";
import type { CodexConnectorConfig } from "./configSchema";
import { makeCodexConnectorDefinition } from "./definition";
import { childEnv } from "./env";
import { isBelowOldestTested } from "./probe";
import { IGNORED } from "./translate/translator";

const LIVE = process.env.POSEIDON_LIVE_CODEX === "1";
const DEBUG = process.env.POSEIDON_LIVE_CODEX_DEBUG === "1";
const CODEX_HOME = process.env.POSEIDON_LIVE_CODEX_HOME;

/** The conformance recording's prompts, so a live run and its replay ask the same. */
const PROMPT = "Reply with exactly: ok";
const APPROVAL_PROMPT = "Create a file named conformance.txt containing exactly the text: ok";
const ALLOWED_PROMPT = "Create a file named allowed.txt containing exactly the text: ok";
const PLAN_PROMPT =
  "Without running any commands, plan how to create hello.txt containing hi. Two steps. Do not ask questions.";

const ROOT = "/tmp/poseidon-codex";

/**
 * Every app-server method the connector sends or handles, by where it goes.
 * The live gate below asserts each still exists in the installed CLI's schema.
 */
const SENT_REQUESTS = [
  "initialize",
  "account/read",
  "model/list",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/compact/start",
];
const SENT_NOTIFICATIONS = ["initialized"];
const HANDLED_SERVER_REQUESTS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
  "execCommandApproval",
  "applyPatchApproval",
];
/** The notifications the translator maps (its `switch`); `IGNORED` adds the dropped ones. */
const MAPPED_NOTIFICATIONS = [
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/patchUpdated",
  "turn/plan/updated",
  "thread/tokenUsage/updated",
  "turn/completed",
  "error",
  "warning",
  "guardianWarning",
  "configWarning",
  "deprecationNotice",
  "model/rerouted",
  "mcpServer/startupStatus/updated",
];
/**
 * Ignored methods the schema does not list: the raw response stream is only
 * sent when a client opts in, which this connector never does. Ignoring them
 * is defensive, so their absence is not a failure.
 */
const IGNORED_OUTSIDE_SCHEMA = new Set(["rawResponse/completed", "rawResponseItem/completed"]);

const debug = (line: string): void => {
  if (DEBUG) process.stderr.write(`[codex live] ${line}\n`);
};

const logger: ConnectorServices["logger"] = {
  log: (level, message) => Effect.sync(() => debug(`${level}: ${message}`)),
};

const ofType = <T extends RuntimeEvent["type"]>(events: ReadonlyArray<RuntimeEvent>, type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

/** The `method` names one generated union schema (`ClientRequest.json`, …) lists. */
const schemaMethods = (dir: string, file: string): ReadonlySet<string> => {
  const schema = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, file), "utf8")) as {
    oneOf?: ReadonlyArray<{
      properties?: { method?: { enum?: ReadonlyArray<string>; const?: string } };
    }>;
  };
  return new Set(
    (schema.oneOf ?? []).flatMap((variant) => {
      const method = variant.properties?.method;
      return [...(method?.enum ?? []), ...(method?.const === undefined ? [] : [method.const])];
    }),
  );
};

if (!LIVE) {
  describe("the real Codex CLI", () => {
    it.skip("is only driven when POSEIDON_LIVE_CODEX=1 — it spends the operator's account", () => {
      // Intentionally empty: the skip itself is the statement.
    });
  });
} else {
  // A live turn is a model round trip: seconds, not the package's 30 s.
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

  NodeFS.mkdirSync(ROOT, { recursive: true });
  const scratch = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(ROOT, "live-conformance-")));
  const workspace = NodePath.join(scratch, "workspace");
  NodeFS.mkdirSync(workspace);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "live@example.invalid"],
    ["config", "user.name", "live"],
    ["commit", "-q", "-m", "seed", "--allow-empty"],
  ]) {
    execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
  }
  debug(`workspace ${workspace}`);

  const config: CodexConnectorConfig = CODEX_HOME === undefined ? {} : { codexHome: CODEX_HOME };
  const definition = makeCodexConnectorDefinition();
  const binary = resolveBinary(config, process.env);
  if (binary === null) throw new Error("POSEIDON_LIVE_CODEX=1, but no codex binary was found");

  /**
   * Whether every CLI this file started is gone, judged from outside: each
   * app-server is a direct child of this process leading its own process
   * group, so every group led by such a child is remembered while it runs,
   * and gone means no process of any of them is left.
   */
  const groups = new Set<number>();
  const isGone = (): boolean => {
    const rows = execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="], {
      encoding: "utf8",
    })
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match === null
          ? []
          : [
              {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                pgid: Number(match[3]),
                command: match[4]!,
              },
            ];
      });
    // The CLI may be a node script (`node …/codex app-server`), so the path is
    // looked for anywhere in the command line. Only a group leader counts: the
    // probe's one-shot runs share this process's own group.
    for (const row of rows) {
      if (
        row.ppid === process.pid &&
        row.pid === row.pgid &&
        row.command.includes(binary.command)
      ) {
        groups.add(row.pgid);
      }
    }
    return !rows.some((row) => groups.has(row.pgid));
  };

  const settings: ThreadSettings = {
    model: "default",
    runtimeMode: "approval-required",
    interactionMode: "default",
  };

  describe("the Codex CLI a live run drives", () => {
    it.effect("is installed, tested, and signed in", () =>
      Effect.gen(function* () {
        const probe = yield* definition.probe(config);
        debug(
          `probe: ${probe.status} ${probe.version ?? "?"} at ${probe.binaryPath ?? "?"}, ${probe.models.length} models`,
        );
        expect(probe.version).toBeDefined();
        expect(isBelowOldestTested(probe.version!)).toBe(false);
        expect(probe.message ?? "", `sign in with: ${probe.loginCommand ?? "codex login"}`).toBe(
          "",
        );
        expect(probe.status).toBe("ready");
        expect(probe.auth).toBe("present");
        expect(probe.models.length).toBeGreaterThan(0);
      }),
    );

    it("still speaks every app-server method the connector sends or handles", () => {
      const out = NodePath.join(scratch, "schema");
      execFileSync(
        binary.command,
        ["app-server", "generate-json-schema", "--experimental", "--out", out],
        { env: childEnv(process.env, config), stdio: "ignore" },
      );
      const clientRequests = schemaMethods(out, "ClientRequest.json");
      const clientNotifications = schemaMethods(out, "ClientNotification.json");
      const serverRequests = schemaMethods(out, "ServerRequest.json");
      const serverNotifications = schemaMethods(out, "ServerNotification.json");
      expect(SENT_REQUESTS.filter((method) => !clientRequests.has(method))).toEqual([]);
      expect(SENT_NOTIFICATIONS.filter((method) => !clientNotifications.has(method))).toEqual([]);
      expect(HANDLED_SERVER_REQUESTS.filter((method) => !serverRequests.has(method))).toEqual([]);
      expect(MAPPED_NOTIFICATIONS.filter((method) => !serverNotifications.has(method))).toEqual([]);
      expect(
        Object.keys(IGNORED).filter(
          (method) => !serverNotifications.has(method) && !IGNORED_OUTSIDE_SCHEMA.has(method),
        ),
      ).toEqual([]);
    });
  });

  // The ladder answers "prompt" for everything, as in the recording: a plain
  // turn uses no tool, and the approval case's write stops on a card.
  runConnectorConformance(definition, {
    instanceId: makeConnectorInstanceId(),
    services: Effect.runSync(testServices({ logger })),
    config,
    session: {
      threadId: makeThreadId(),
      projectId: makeProjectId(),
      workspaceRoot: workspace,
      settings,
    },
    turn: { text: PROMPT, attachments: [], mentions: [] },
    approvalTurn: { text: APPROVAL_PROMPT, attachments: [], mentions: [] },
    isProcessGone: () => Effect.sync(isGone),
  });

  /** One live session: `drive` runs its turns; answers every event it emitted, once closed. */
  const liveSession = (
    sessionSettings: ThreadSettings,
    drive: (
      handle: SessionHandle,
      collector: StreamCollector<RuntimeEvent>,
    ) => Effect.Effect<void, unknown, Scope.Scope>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* definition.createInstance({
          instanceId: makeConnectorInstanceId(),
          config,
          services: yield* testServices({ logger }),
        });
        const handle = yield* instance.startSession({
          threadId: makeThreadId(),
          projectId: makeProjectId(),
          workspaceRoot: workspace,
          settings: sessionSettings,
        });
        const collector = yield* makeStreamCollector(handle.events);
        yield* drive(handle, collector);
        yield* handle.close();
        yield* collector.awaitDone;
        const events = yield* collector.collected;
        for (const event of events) debug(`event ${event.type}`);
        return events;
      }),
    );

  const turn = (text: string) => ({ text, attachments: [], mentions: [] });

  /** Nothing unmapped and no runtime error: the assertion every live turn ends on. */
  const expectClean = (events: ReadonlyArray<RuntimeEvent>) => {
    const unmapped = ofType(events, "event.unmapped").map((event) =>
      JSON.stringify(event.raw).slice(0, 300),
    );
    expect(unmapped).toEqual([]);
    expect(ofType(events, "runtime.error").map((event) => event.payload.message)).toEqual([]);
  };

  describe("a live turn's notifications", () => {
    it.live("all map — nothing falls through to event.unmapped", () =>
      Effect.gen(function* () {
        const events = yield* liveSession(settings, (handle, collector) =>
          Effect.gen(function* () {
            yield* handle.send(turn(PROMPT));
            yield* collector.awaitItem((event) => event.type === "turn.completed");
          }),
        );
        expectClean(events);
        expect(ofType(events, "session.started").length).toBeGreaterThan(0);
        const said = ofType(events, "item.completed")
          .map((event) => event.payload.item)
          .filter((item) => item.kind === "assistant_message")
          .map((item) => item.text ?? "");
        expect(said.join(" ").toLowerCase()).toContain("ok");
        expect(ofType(events, "usage.updated").length).toBeGreaterThan(0);
      }),
    );
  });

  describe("a live approval answered allow once", () => {
    it.live("asks first, then writes the file", () =>
      Effect.gen(function* () {
        const target = NodePath.join(workspace, "allowed.txt");
        NodeFS.rmSync(target, { force: true });
        const events = yield* liveSession(settings, (handle, collector) =>
          Effect.gen(function* () {
            const answered = yield* answerCards({ handle, collector }, "allow-once");
            yield* handle.send(turn(ALLOWED_PROMPT));
            yield* collector.awaitItem((event) => event.type === "turn.completed");
            expect(answered.size).toBeGreaterThan(0);
          }),
        );
        expectClean(events);
        const opened = ofType(events, "request.opened").map((e) => e.payload.request.requestId);
        const resolved = new Set(
          ofType(events, "request.resolved").map((e) => e.payload.requestId),
        );
        expect(opened.length).toBeGreaterThan(0);
        expect(opened.filter((id) => !resolved.has(id))).toEqual([]);
        expect(NodeFS.readFileSync(target, "utf8").trim()).toBe("ok");
      }),
    );
  });

  describe("a live plan turn", () => {
    it.live("hands its plan over", () =>
      Effect.gen(function* () {
        const events = yield* liveSession(
          { ...settings, interactionMode: "plan" },
          (handle, collector) =>
            Effect.gen(function* () {
              yield* handle.send(turn(PLAN_PROMPT));
              yield* collector.awaitItem((event) => event.type === "turn.completed");
            }),
        );
        expectClean(events);
        expect(ofType(events, "turn.plan.proposed").length).toBe(1);
        const plans = ofType(events, "item.completed").filter(
          (event) => event.payload.item.kind === "plan",
        );
        expect(plans.length).toBeGreaterThan(0);
      }),
    );
  });
}

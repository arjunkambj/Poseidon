/**
 * The conformance suite against the operator's REAL Claude Code CLI.
 *
 * Every other test of this connector replays a recording. This one spends the
 * operator's subscription, so it is opt-in and never runs in the gate:
 *
 *     POSEIDON_LIVE_CLAUDE=1 pnpm -F @poseidon/connector-claude vitest run src/liveConformance.test.ts
 *
 * What it proves that a replay cannot: that the CLI installed today still
 * accepts the argv and the control requests the SDK and the connector send,
 * that it is signed in, that a real model's messages still map without
 * falling through to `event.unmapped`, and that its tool calls still reach
 * Poseidon's approval gate. When the CLI changes under us, this is what says
 * so; a recording it disagrees with is stale, and is recorded again rather
 * than edited.
 *
 * Kept deliberately cheap: the CLI's default model only (`default`, which
 * leaves the SDK's `model` option out), one-line prompts, and the same caps
 * the conformance recording runs under — one turn and fifty cents a session.
 * The approval case asks for one small file write and allows it once; the
 * deny case asks for another and refuses it.
 *
 * `HOME` is the operator's own, because that is where the CLI's credentials
 * and settings live; `POSEIDON_LIVE_CLAUDE_CONFIG_DIR` points the instance at
 * a separate account. The workspace is a throwaway git repo under
 * `/tmp/poseidon-h1`. `POSEIDON_LIVE_CLAUDE_DEBUG=1` prints the connector's log
 * lines and, for the turns this file drives itself, every event type.
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
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import * as Effect from "effect/Effect";
import { vi } from "vitest";

import { testServices } from "../test/services";
import { resolveBinary } from "./binary";
import type { ClaudeConnectorConfig } from "./configSchema";
import { makeClaudeConnectorDefinition } from "./definition";
import { isBelowOldestTested } from "./probe";

const LIVE = process.env.POSEIDON_LIVE_CLAUDE === "1";
const DEBUG = process.env.POSEIDON_LIVE_CLAUDE_DEBUG === "1";
const CONFIG_DIR = process.env.POSEIDON_LIVE_CLAUDE_CONFIG_DIR;

/** The conformance recording's prompts, so a live run and its replay ask the same. */
const PROMPT = "Reply with exactly: ok";
const APPROVAL_PROMPT = "Create a file named conformance.txt containing exactly the text: ok";
const DENY_PROMPT = "Create a file named denied.txt containing exactly the text: no";

/** The conformance recording's caps. */
const LIMITS = { maxTurns: 1, maxBudgetUsd: 0.5 } as const;

const ROOT = "/tmp/poseidon-h1";

const debug = (line: string): void => {
  if (DEBUG) process.stderr.write(`[claude live] ${line}\n`);
};

const logger: ConnectorServices["logger"] = {
  log: (level, message) => Effect.sync(() => debug(`${level}: ${message}`)),
};

const ofType = <T extends RuntimeEvent["type"]>(events: ReadonlyArray<RuntimeEvent>, type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

if (!LIVE) {
  describe("the real Claude Code CLI", () => {
    it.skip("is only driven when POSEIDON_LIVE_CLAUDE=1 — it spends the operator's subscription", () => {
      // Intentionally empty: the skip itself is the statement.
    });
  });
} else {
  // A live turn is a model round trip: seconds, not the package's 30 s. The
  // shared suite's approval case waits for a card and nothing else, and a
  // session outlives a failed turn, so a CLI that never asks — signed out,
  // say — fails that case at this ceiling rather than at once.
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

  const config: ClaudeConnectorConfig = CONFIG_DIR === undefined ? {} : { configDir: CONFIG_DIR };
  const definition = makeClaudeConnectorDefinition({ limits: LIMITS });
  const binary = resolveBinary(config, process.env);
  if (binary === null) throw new Error("POSEIDON_LIVE_CLAUDE=1, but no claude binary was found");

  /**
   * Whether every CLI this file started is gone, judged from outside as the
   * suite requires: the connector spawns each CLI as a direct child of this
   * process, leading its own process group, so every group led by such a
   * child is remembered while it runs, and gone means no process of any of
   * them is left.
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
                ppid: Number(match[2]),
                pgid: Number(match[3]),
                command: match[4]!,
              },
            ];
      });
    for (const row of rows) {
      if (row.ppid === process.pid && row.command.startsWith(binary.command)) groups.add(row.pgid);
    }
    return !rows.some((row) => groups.has(row.pgid));
  };

  const settings = {
    model: "default",
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
  };

  describe("the Claude Code CLI a live run drives", () => {
    it.effect("is installed, tested, and signed in", () =>
      Effect.gen(function* () {
        const probe = yield* definition.probe(config);
        debug(
          `probe: ${probe.status} ${probe.version ?? "?"} at ${probe.binaryPath ?? "?"}, ${probe.models.length} models`,
        );
        expect(probe.version).toBeDefined();
        expect(isBelowOldestTested(probe.version!)).toBe(false);
        // Signed out, every turn below ends in the CLI's login error; say so
        // here, once, with the command that fixes it.
        expect(
          probe.message ?? "",
          `sign in with: ${probe.loginCommand ?? "claude auth login"}`,
        ).toBe("");
        expect(probe.status).toBe("ready");
        expect(probe.models.length).toBeGreaterThan(0);
      }),
    );
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
    decision: "allow" | "prompt",
    drive: (
      handle: SessionHandle,
      collector: StreamCollector<RuntimeEvent>,
    ) => Effect.Effect<void, unknown>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* definition.createInstance({
          instanceId: makeConnectorInstanceId(),
          config,
          services: yield* testServices({ decision, logger }),
        });
        const handle = yield* instance.startSession({
          threadId: makeThreadId(),
          projectId: makeProjectId(),
          workspaceRoot: workspace,
          settings,
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

  describe("a live turn's messages", () => {
    it.live("all map — nothing falls through to event.unmapped", () =>
      Effect.gen(function* () {
        const events = yield* liveSession("allow", (handle, collector) =>
          Effect.gen(function* () {
            yield* handle.send(turn(PROMPT));
            yield* collector.awaitItem((event) => event.type === "turn.completed");
          }),
        );

        // The assertion this case exists for: a CLI that grew a message type
        // we do not read fails here.
        const unmapped = ofType(events, "event.unmapped").map((event) =>
          JSON.stringify(event.raw).slice(0, 300),
        );
        expect(unmapped).toEqual([]);
        expect(ofType(events, "runtime.error").map((event) => event.payload.message)).toEqual([]);

        // And the run really happened: a session, an answer, usage.
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

  /**
   * The claim the whole approval gate rests on, against the real CLI: a card
   * answered deny stops the write, and the file is never created.
   */
  describe("a live approval answered deny", () => {
    it.live("stops the write, fails its row, and leaves the file uncreated", () =>
      Effect.gen(function* () {
        const target = NodePath.join(workspace, "denied.txt");
        NodeFS.rmSync(target, { force: true });
        const events = yield* liveSession("prompt", (handle, collector) =>
          Effect.gen(function* () {
            yield* handle.send(turn(DENY_PROMPT));
            const opened = yield* collector.awaitItem(
              (event) => event.type === "request.opened" || event.type === "turn.completed",
            );
            if (opened.type !== "request.opened") {
              throw new Error("the turn finished without asking for approval");
            }
            // Nothing written while the card waits.
            expect(NodeFS.existsSync(target)).toBe(false);
            yield* handle.respondToRequest(opened.payload.request.requestId, "deny");
            yield* collector.awaitItem((event) => event.type === "turn.completed");
          }),
        );

        const opened = ofType(events, "request.opened").map((e) => e.payload.request.requestId);
        const resolved = new Set(
          ofType(events, "request.resolved").map((e) => e.payload.requestId),
        );
        expect(opened.length).toBeGreaterThan(0);
        expect(opened.filter((id) => !resolved.has(id))).toEqual([]);
        expect(ofType(events, "session.warning")).toEqual([]);
        const writes = ofType(events, "item.completed")
          .map((event) => event.payload.item)
          .filter((item) => item.kind === "file_change");
        expect(writes.length).toBeGreaterThan(0);
        expect(writes.every((item) => item.status === "failed")).toBe(true);
        // The point of the whole gate: the write did not happen.
        expect(NodeFS.existsSync(target)).toBe(false);
      }),
    );
  });
}

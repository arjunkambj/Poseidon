/**
 * The Codex definition against the session recordings: each scenario's
 * app-server launches, replayed behind the binary path, with the connector's
 * real spawn, JSON-RPC client, handshake and translation in front of them.
 *
 * `plain-reply`: streamed text settling as one assistant row, usage and the
 * context window, the MCP servers the thread started (Poseidon's own among
 * them), and a turn that ended `end_turn`. `interrupt`: a turn stopped on its
 * first text, then a follow-up on the same process. `resume`: a second
 * process resuming the thread by the first one's ref and recalling the word.
 * `resume-missing`: a resume of a thread the CLI does not have, started
 * afresh with a warning. `model-switch`: `model.changed`, and the second turn
 * on the switched model. `image`: a PNG as a `localImage` input.
 *
 * Every replay checks what the connector sent against what the recording
 * says it sent, so a request the connector stopped making, or made in
 * another order, fails here; the divergence log must stay empty.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { TurnInput } from "@poseidon/connector-sdk/definition";
import type { SessionHandle } from "@poseidon/connector-sdk/sessionHandle";
import { makeStreamCollector, type StreamCollector } from "@poseidon/connector-sdk/streamCollector";
import { makeConnectorInstanceId, makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import { loadStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { isPidGone, replay, type Replay } from "../test/replay";
import { testServices } from "../test/services";
import { makeCodexConnectorDefinition, UNREADABLE_REF_WARNING } from "./definition";
import { CODEX_KIND } from "./kind";
import { parseSessionRef } from "./sessionRef";
import { MISSING_THREAD_WARNING } from "./threadOpen";

const SETTINGS: ThreadSettings = {
  model: "default",
  runtimeMode: "approval-required",
  interactionMode: "default",
};

/** A 2×2 solid red PNG, the one `image` was recorded with. */
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4IycHRAwQCgAhpgRhTxp8CQAAAABJRU5ErkJggg==";

const ofType = <T extends RuntimeEvent["type"]>(events: ReadonlyArray<RuntimeEvent>, type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

/** The settled snapshot of every row of `kind`. */
const rows = (events: ReadonlyArray<RuntimeEvent>, kind: string) =>
  ofType(events, "item.completed")
    .map((event) => event.payload.item)
    .filter((item) => item.kind === kind);

const text = (value: string, attachments: TurnInput["attachments"] = []): TurnInput => ({
  text: value,
  attachments,
  mentions: [],
});

interface Opened {
  readonly handle: SessionHandle;
  readonly collector: StreamCollector<RuntimeEvent>;
}

/**
 * An instance on `scenario`'s replay, and a way to open its sessions in one
 * workspace. `assertDone` proves every replayed process gone and the
 * recording played out.
 */
const replaying = (scenario: string) =>
  Effect.gen(function* () {
    const replayed: Replay = replay(scenario);
    const workspace = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-session-")),
      scenario,
    );
    NodeFS.mkdirSync(workspace);
    const instance = yield* makeCodexConnectorDefinition().createInstance({
      instanceId: makeConnectorInstanceId(),
      config: { binaryPath: replayed.binaryPath },
      services: yield* testServices(),
    });
    const input = {
      threadId: makeThreadId(),
      projectId: makeProjectId(),
      workspaceRoot: workspace,
      settings: SETTINGS,
    };
    const open = (sessionRef?: unknown): Effect.Effect<Opened, unknown, Scope.Scope> =>
      Effect.gen(function* () {
        const handle = yield* sessionRef === undefined
          ? instance.startSession(input)
          : instance.resumeSession({ ...input, sessionRef });
        return { handle, collector: yield* makeStreamCollector(handle.events) };
      });
    const assertDone = () => {
      replayed.assertPlayedOut();
      expect(replayed.pids().length).toBeGreaterThan(0);
      expect(replayed.pids().every(isPidGone)).toBe(true);
    };
    return { open, assertDone, workspace, replayed };
  });

/** Sends one turn and waits for its completion. */
const turn = (opened: Opened, input: TurnInput) =>
  Effect.gen(function* () {
    const before = new Set(yield* opened.collector.collected);
    yield* opened.handle.send(input);
    return yield* opened.collector.awaitItem(
      (event) => !before.has(event) && event.type === "turn.completed",
    );
  });

/** Closes the session; answers everything it emitted. */
const closed = (opened: Opened) =>
  Effect.gen(function* () {
    yield* opened.handle.close();
    yield* opened.collector.awaitDone;
    return yield* opened.collector.collected;
  });

const prompts = (scenario: string) =>
  loadStdioJsonRpcRecording(CODEX_KIND, scenario).manifest.prompts;

const stopReasons = (events: ReadonlyArray<RuntimeEvent>) =>
  ofType(events, "turn.completed").map((event) => event.payload.stopReason);

describe("a Codex session replaying codex/plain-reply", () => {
  it.live("answers the turn with streamed text, usage, the context and end_turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone } = yield* replaying("plain-reply");
        const session = yield* open();
        yield* turn(session, text(prompts("plain-reply")[0]!));
        const events = yield* closed(session);
        assertDone();

        expect(events[0]?.type).toBe("session.started");
        const started = ofType(events, "session.started")[0]!.payload;
        expect(parseSessionRef(started.sessionRef)).toBeDefined();
        expect(started.model).toBe("default");
        expect(stopReasons(events)).toEqual(["end_turn"]);
        expect(ofType(events, "event.unmapped")).toEqual([]);
        expect(ofType(events, "runtime.error")).toEqual([]);
        expect(ofType(events, "session.warning")).toEqual([]);

        const settled = rows(events, "assistant_message");
        expect(settled).toHaveLength(1);
        expect(settled[0]!.text).toBe("ok");
        const deltas = ofType(events, "content.delta");
        expect(deltas.map((event) => event.payload.delta).join("")).toBe("ok");
        expect(new Set(deltas.map((event) => event.payload.itemId))).toEqual(
          new Set([settled[0]!.itemId]),
        );

        const usage = ofType(events, "usage.updated").at(-1)!.payload;
        expect(usage.output).toBeGreaterThan(0);
        expect(usage.cacheRead).toBeGreaterThan(0);
        expect(usage.input).toBeGreaterThan(0);
        const context = ofType(events, "context.updated").at(-1)!.payload;
        expect(context.limit).toBeGreaterThan(context.used);

        // Poseidon's MCP server was handed over and tried (nothing listens on
        // the test's endpoint, so it failed).
        const mcp = ofType(events, "mcp.status.updated").at(-1)!.payload.servers;
        expect(mcp).toContainEqual({ name: "poseidon", status: "failed" });

        expect(ofType(events, "session.ended").map((event) => event.payload.reason)).toEqual([
          "stopped",
        ]);
      }),
    ),
  );

  it.live("starts afresh, and says so, when the stored reference is not one of its own", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone } = yield* replaying("plain-reply");
        const session = yield* open({ sessionId: "not a codex ref" });
        yield* turn(session, text(prompts("plain-reply")[0]!));
        const events = yield* closed(session);
        assertDone();
        expect(ofType(events, "session.warning").map((event) => event.payload.message)).toEqual([
          UNREADABLE_REF_WARNING,
        ]);
        expect(stopReasons(events)).toEqual(["end_turn"]);
      }),
    ),
  );
});

describe("a Codex session replaying codex/interrupt", () => {
  it.live("stops the turn on its first text, then answers a follow-up in the same process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone, replayed } = yield* replaying("interrupt");
        const [counting, followUp] = prompts("interrupt");
        const session = yield* open();
        yield* session.handle.send(text(counting!));
        yield* session.collector.awaitItem((event) => event.type === "content.delta");
        yield* session.handle.interrupt();
        yield* session.collector.awaitItem((event) => event.type === "turn.completed");
        yield* turn(session, text(followUp!));
        const events = yield* closed(session);
        assertDone();

        expect(stopReasons(events)).toEqual(["interrupted", "end_turn"]);
        expect(replayed.pids()).toHaveLength(1);
        // The interrupted answer's row is failed, not left spinning.
        const answers = rows(events, "assistant_message");
        expect(answers.map((row) => row.status)).toEqual(["failed", "completed"]);
        expect(answers[1]!.text).toBe("ok");
        expect(ofType(events, "event.unmapped")).toEqual([]);
      }),
    ),
  );
});

describe("a Codex session replaying codex/resume", () => {
  it.live("resumes the thread in a second process, which recalls the first turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone, replayed } = yield* replaying("resume");
        const [remember, recall] = prompts("resume");
        const first = yield* open();
        yield* turn(first, text(remember!));
        const ref = yield* first.handle.sessionRef();
        const before = yield* closed(first);

        const second = yield* open(ref);
        yield* turn(second, text(recall!));
        const after = yield* closed(second);
        assertDone();
        expect(replayed.pids()).toHaveLength(2);

        const resumedRef = ofType(after, "session.started")[0]!.payload.sessionRef;
        expect(resumedRef).toEqual(ref);
        expect(ofType(after, "session.warning")).toEqual([]);
        expect(rows(after, "assistant_message")[0]!.text).toBe("walrus");
        expect(stopReasons([...before, ...after])).toEqual(["end_turn", "end_turn"]);

        // The resumed thread's token total carries the first turn; the second
        // turn's usage is only its own share of it.
        const firstUsage = ofType(before, "usage.updated").at(-1)!.payload;
        const secondUsage = ofType(after, "usage.updated").at(-1)!.payload;
        const firstIn = firstUsage.input + firstUsage.cacheRead;
        const secondIn = secondUsage.input + secondUsage.cacheRead;
        expect(secondIn).toBeGreaterThan(0);
        expect(secondIn).toBeLessThan(firstIn * 1.5);
      }),
    ),
  );
});

describe("a Codex session replaying codex/resume-missing", () => {
  it.live("starts a new thread, with a warning, when the CLI has no rollout for the ref", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone, workspace } = yield* replaying("resume-missing");
        const missing = { threadId: "01a0e600-0000-7000-8000-000000000000", cwd: workspace };
        const session = yield* open(missing);
        yield* session.collector.awaitItem((event) => event.type === "session.warning");
        const events = yield* closed(session);
        assertDone();

        expect(ofType(events, "session.warning").map((event) => event.payload.message)).toEqual([
          MISSING_THREAD_WARNING,
        ]);
        const ref = parseSessionRef(ofType(events, "session.started")[0]!.payload.sessionRef);
        expect(ref?.threadId).toBeDefined();
        expect(ref?.threadId).not.toBe(missing.threadId);
      }),
    ),
  );
});

describe("a Codex session replaying codex/model-switch", () => {
  it.live("says model.changed at once, and runs the next turn on the new model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone } = yield* replaying("model-switch");
        const [first, second] = prompts("model-switch");
        const session = yield* open();
        yield* turn(session, text(first!));
        yield* session.handle.updateSettings({ model: "gpt-6-luna", effort: "low" });
        yield* turn(session, text(second!));
        const events = yield* closed(session);
        assertDone();

        expect(ofType(events, "model.changed").map((event) => event.payload)).toEqual([
          { model: "gpt-6-luna", effort: "low" },
        ]);
        expect(stopReasons(events)).toEqual(["end_turn", "end_turn"]);
        expect(rows(events, "assistant_message").map((row) => row.text)).toEqual(["ok", "ok"]);
      }),
    ),
  );
});

describe("a Codex session replaying codex/image", () => {
  it.live("sends the PNG as an image, and the model names its colour", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone, workspace } = yield* replaying("image");
        const image = NodePath.join(workspace, "red.png");
        NodeFS.writeFileSync(image, Buffer.from(RED_PNG_BASE64, "base64"));
        const session = yield* open();
        yield* turn(
          session,
          text(prompts("image")[0]!, [{ path: image, mime: "image/png", name: "red.png" }]),
        );
        const events = yield* closed(session);
        assertDone();

        expect(stopReasons(events)).toEqual(["end_turn"]);
        expect(rows(events, "assistant_message")[0]!.text?.toLowerCase()).toBe("red");
        expect(ofType(events, "session.warning")).toEqual([]);
      }),
    ),
  );
});

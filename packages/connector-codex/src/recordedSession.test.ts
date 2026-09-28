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
 * `edit-approval`, `deny` and `sensitive-full-access`: the CLI's approval
 * requests reaching the ladder and a card, and the card's answer reaching the
 * CLI — accept, decline, and a read of `.env` stopped even under full access.
 *
 * Every replay checks what the connector sent against what the recording
 * says it sent, so a request the connector stopped making, or made in
 * another order, fails here; the divergence log must stay empty.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { RuntimeEvent } from "@poseidon/contracts/runtime";
import * as Effect from "effect/Effect";

import {
  closed,
  ofType,
  prompts,
  replaying,
  rows,
  SETTINGS,
  stopReasons,
  text,
  turn,
  turnWithCard,
} from "../test/replaySession";
import { UNREADABLE_REF_WARNING } from "./definition";
import { parseSessionRef } from "./sessionRef";
import { MISSING_THREAD_WARNING } from "./threadOpen";

/** A 2×2 solid red PNG, the one `image` was recorded with. */
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4IycHRAwQCgAhpgRhTxp8CQAAAABJRU5ErkJggg==";

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

describe("a Codex session replaying codex/edit-approval", () => {
  it.live("opens a card for the file change, and the write runs once allowed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone, workspace } = yield* replaying("edit-approval");
        const session = yield* open();
        const { request } = yield* turnWithCard(
          session,
          text(prompts("edit-approval")[0]!),
          "allow-once",
        );
        const events = yield* closed(session);
        assertDone();

        // The replay restores the scratch root as the workspace's real path.
        const hello = NodePath.join(NodeFS.realpathSync(workspace), "hello.txt");
        expect(request).toMatchObject({
          kind: "file_write",
          toolName: "Edit",
          input: { file_path: hello },
          patternSuggestion: `Edit(${hello})`,
        });
        expect(ofType(events, "request.resolved").map((event) => event.payload.decision)).toEqual([
          "allow-once",
        ]);
        const change = rows(events, "file_change");
        expect(change.map((row) => row.status)).toEqual(["completed"]);
        expect(change[0]!.fileChange?.path).toBe(hello);
        expect(stopReasons(events)).toEqual(["end_turn"]);
        expect(ofType(events, "session.warning")).toEqual([]);
        expect(ofType(events, "event.unmapped")).toEqual([]);
      }),
    ),
  );
});

describe("a Codex session replaying codex/deny", () => {
  it.live("opens a card for the command, and the denied command never runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone, workspace } = yield* replaying("deny");
        const session = yield* open();
        const { request } = yield* turnWithCard(session, text(prompts("deny")[0]!), "deny");
        const events = yield* closed(session);
        assertDone();

        expect(request).toMatchObject({
          kind: "command",
          toolName: "Shell",
          input: { command: "touch denied.txt", cwd: NodeFS.realpathSync(workspace) },
          patternSuggestion: "Shell(touch *)",
        });
        expect(ofType(events, "request.resolved").map((event) => event.payload.decision)).toEqual([
          "deny",
        ]);
        expect(rows(events, "command_execution").map((row) => row.status)).toEqual(["failed"]);
        expect(stopReasons(events)).toEqual(["end_turn"]);
        expect(ofType(events, "session.warning")).toEqual([]);
      }),
    ),
  );
});

describe("a Codex session replaying codex/sensitive-full-access", () => {
  it.live("asks about cat .env even under full access, and the ladder is the one asked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone } = yield* replaying("sensitive-full-access", {
          ...SETTINGS,
          runtimeMode: "full-access",
        });
        const session = yield* open();
        const { request } = yield* turnWithCard(
          session,
          text(prompts("sensitive-full-access")[0]!),
          "deny",
        );
        const events = yield* closed(session);
        assertDone();

        // The ladder reads `.env` as an argument of the command line, which is
        // what makes its sensitive-path rung prompt under full access.
        expect(request).toMatchObject({ kind: "command", input: { command: "cat .env" } });
        expect(rows(events, "command_execution").map((row) => row.status)).toEqual(["failed"]);
        expect(stopReasons(events)).toEqual(["end_turn"]);
        expect(ofType(events, "session.warning")).toEqual([]);
      }),
    ),
  );
});

describe("a Codex session replaying codex/approval-stop", () => {
  it.live("Stop and close each resolve the open card once, and nothing is written", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, assertDone } = yield* replaying("approval-stop");
        const [stopEdit, closeEdit] = prompts("approval-stop");
        const session = yield* open();
        yield* session.handle.send(text(stopEdit!));
        const first = yield* session.collector.awaitItem(
          (event) => event.type === "request.opened",
        );
        yield* session.handle.interrupt();
        yield* session.collector.awaitItem((event) => event.type === "turn.completed");
        yield* session.handle.send(text(closeEdit!));
        yield* session.collector.awaitItem(
          (event) => event.type === "request.opened" && event !== first,
        );
        const events = yield* closed(session);
        assertDone();

        const opened = ofType(events, "request.opened").map((event) => event.payload.request);
        expect(opened.map((request) => request.toolName)).toEqual(["Edit", "Edit"]);
        const resolved = ofType(events, "request.resolved").map((event) => event.payload);
        expect(resolved).toEqual(
          opened.map((request) => ({ requestId: request.requestId, decision: "deny" })),
        );
        // The first by Stop, before its turn ended; the second by close,
        // before the session did.
        const index = (event: RuntimeEvent) => events.indexOf(event);
        const resolutions = ofType(events, "request.resolved");
        const completion = ofType(events, "turn.completed")[0]!;
        expect(index(resolutions[0]!)).toBeLessThan(index(completion));
        expect(index(resolutions[1]!)).toBeLessThan(index(ofType(events, "session.ended")[0]!));
        expect(stopReasons(events)).toEqual(["interrupted"]);
        expect(rows(events, "file_change").map((row) => row.status)).toEqual(["failed"]);
        expect(ofType(events, "session.warning")).toEqual([]);
        expect(ofType(events, "event.unmapped")).toEqual([]);
      }),
    ),
  );
});

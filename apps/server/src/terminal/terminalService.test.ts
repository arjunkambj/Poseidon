/**
 * The terminal service over a real engine and a real `/bin/sh`, with `HOME` in
 * a temp dir so no rc file of the machine's user can change what the shell
 * prints:
 *
 * - A command's computed output reaches a subscriber, and the shell runs in
 *   the project's folder.
 * - A second subscriber reattaches: its snapshot holds the scrollback and
 *   lines up with the first subscriber's output, nothing lost or doubled.
 * - Resize reaches the shell; open is idempotent by id; the per-owner limit
 *   holds.
 * - An exited shell stays listed with its output until it is closed.
 * - A script terminal runs its command through the shell's `-c`, carries the
 *   script in its summary and exits with the script's own code.
 * - Close, thread.deleted, thread.archived and the service's scope closing
 *   each end the shell; a close interrupted part way still ends it. An
 *   archived thread refuses a new terminal.
 * - A project owns terminals of its own, before any thread exists: they start
 *   in its folder, are kept apart from its threads' terminals, and end when
 *   the project is removed.
 * - A project's terminals hand over to a local thread of it (`adopt`) with
 *   their ids, status and scrollback, a live subscriber streaming on through
 *   the move; a worktree thread, another project's thread or a gone one is
 *   refused, the per-owner limit holds, and an open racing the move leaves
 *   every terminal with exactly one owner.
 *
 * Every wait is on output the shell computed or on an exit, never on time: the
 * terminal echoes what is typed, so matching the typed text would pass without
 * the shell running anything.
 */
import { describe, expect, it } from "@effect/vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import { makeStreamCollector, type StreamCollector } from "@poseidon/connector-sdk/streamCollector";
import {
  makeCommandId,
  makeProjectId,
  makeTerminalId,
  makeThreadId,
  type ProjectId,
  type ThreadId,
} from "@poseidon/contracts/ids";
import type { PoseidonRpcError } from "@poseidon/contracts/rpc";
import { TERMINALS_PER_OWNER, type TerminalStreamItem } from "@poseidon/contracts/terminal";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngine } from "../orchestration/Engine";
import { EventStore } from "../persistence/EventStore";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import type { TerminalService } from "../rpc/services";
import { type PtyExit, type PtyProcess, spawnPty } from "./pty";
import { adoptionCheckOf, makeTerminalService, workspaceOf } from "./TerminalService";

const NOW = "2026-01-02T03:04:05.000Z";
const SIZE = { cols: 80, rows: 24 };

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A line of output that is exactly `text`, not the echo of a command containing it. */
const line = (text: string) => new RegExp(`(^|\\n)${escapeRegExp(text)}\\r?\\n`);

const tempDir = (label: string) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(nodePath.join(tmpdir(), `poseidon-terminal-${label}-`))),
    (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
  );

interface Seen {
  readonly item: TerminalStreamItem;
  /** Everything the subscriber has been shown so far: the snapshot, then each output. */
  readonly text: string;
}

/** A subscriber that keeps a running transcript, so a wait can match across items. */
const watch = <E>(
  stream: Stream.Stream<TerminalStreamItem, E>,
): Effect.Effect<StreamCollector<Seen>, never, Scope.Scope> =>
  makeStreamCollector(
    stream.pipe(
      Stream.mapAccum(
        () => "",
        (text, item): readonly [string, ReadonlyArray<Seen>] => {
          const next = item.kind === "snapshot" || item.kind === "output" ? text + item.data : text;
          return [next, [{ item, text: next }]];
        },
      ),
    ),
  );

const awaitText = (collector: StreamCollector<Seen>, pattern: RegExp) =>
  collector.awaitItem((seen) => pattern.test(seen.text)).pipe(Effect.orDie);

const awaitKind = (collector: StreamCollector<Seen>, kind: TerminalStreamItem["kind"]) =>
  collector.awaitItem((seen) => seen.item.kind === kind).pipe(Effect.orDie);

interface Stack {
  readonly engine: OrchestrationEngine["Service"];
  /** The project every thread here is on, rooted at `workspace`. */
  readonly projectId: ProjectId;
  readonly workspace: string;
  readonly home: string;
  /** Builds the service in `scope`, spawning through `spawn`. */
  readonly service: (
    scope: Scope.Scope,
    spawn?: typeof spawnPty,
  ) => Effect.Effect<TerminalService["Service"]>;
  /** A thread on a project rooted at `workspace`, in `worktree` when given one. */
  readonly thread: Effect.Effect<ThreadId>;
  readonly worktreeThread: (worktree: string) => Effect.Effect<ThreadId>;
}

const buildStack: Effect.Effect<Stack, never, Scope.Scope> = Effect.gen(function* () {
  const sqliteContext = yield* Layer.build(sqliteTestLayer()).pipe(Effect.orDie);
  const sqlite = Layer.succeedContext(sqliteContext);
  const persistence = Layer.mergeAll(
    sqlite,
    Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
  );
  const context = yield* Layer.build(OrchestrationEngine.layer.pipe(Layer.provide(persistence)));
  const engine = Context.get(context, OrchestrationEngine);
  const workspace = yield* tempDir("workspace");
  const home = yield* tempDir("home");
  const projectId = makeProjectId();
  yield* engine.dispatch({
    commandId: makeCommandId(),
    createdAt: NOW,
    type: "project.create",
    projectId,
    name: "demo",
    workspaceRoot: workspace,
  });
  const createThread = (worktree: string | undefined) =>
    Effect.gen(function* () {
      const threadId = makeThreadId();
      yield* engine.dispatch({
        commandId: makeCommandId(),
        createdAt: NOW,
        type: "thread.create",
        threadId,
        projectId,
        settings: { model: "fake/model" },
        ...(worktree === undefined
          ? {}
          : { worktree: { path: worktree, branch: "poseidon/fix", baseBranch: "main" } }),
      });
      return threadId;
    }).pipe(Effect.orDie);
  return {
    engine,
    projectId,
    workspace,
    home,
    service: (scope: Scope.Scope, spawn: typeof spawnPty = spawnPty) =>
      makeTerminalService({
        workspaceFor: workspaceOf(engine, home),
        adoptionCheck: adoptionCheckOf(engine),
        events: engine.subscribeEvents,
        spawn,
        shell: { file: "/bin/sh", args: [] },
        env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", PS1: "$ " },
      }).pipe(Scope.provide(scope)),
    thread: createThread(undefined),
    worktreeThread: (path: string) => createThread(path),
  };
}).pipe(Effect.orDie);

/** The stack plus a service bound to the calling scope and one thread with a terminal. */
const withTerminal = Effect.gen(function* () {
  const stack = yield* buildStack;
  const terminals = yield* stack.service(yield* Effect.scope);
  const threadId = yield* stack.thread;
  const terminalId = makeTerminalId();
  const opened = yield* terminals.open({ threadId, terminalId, ...SIZE });
  return { ...stack, terminals, threadId, terminalId, opened };
});

const failureCode = <A>(effect: Effect.Effect<A, PoseidonRpcError>) =>
  Effect.map(Effect.flip(effect), (error) => error.code);

describe.skipIf(process.platform === "win32")("TerminalService", () => {
  it.live("runs a command and streams what it computed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId, opened } = yield* withTerminal;
        expect(opened).toMatchObject({ title: "Terminal", status: "running", exitCode: null });
        expect(opened.pid).toBeGreaterThan(0);

        const output = yield* watch(terminals.subscribe({ threadId }, terminalId));
        yield* terminals.write({ threadId }, terminalId, "echo $((20+22))\n");
        yield* awaitText(output, line("42"));
        const first = (yield* output.collected)[0]!.item;
        expect(first.kind).toBe("snapshot");
      }),
    ),
  );

  it.live("starts the shell in the project's folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId, workspace } = yield* withTerminal;
        const output = yield* watch(terminals.subscribe({ threadId }, terminalId));
        // `-P`: the directory the process is really in, not the `$PWD` it was handed.
        yield* terminals.write({ threadId }, terminalId, "pwd -P\n");
        yield* awaitText(output, line(realpathSync(workspace)));
      }),
    ),
  );

  it.live("reattaches with the scrollback, lined up with the live output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId } = yield* withTerminal;
        const first = yield* watch(terminals.subscribe({ threadId }, terminalId));
        yield* terminals.write({ threadId }, terminalId, "echo $((20+22))\n");
        yield* awaitText(first, line("42"));
        const seenByFirst = (yield* first.collected).map(({ item }) =>
          item.kind === "snapshot" || item.kind === "output" ? item.offset : 0,
        );

        const second = yield* watch(terminals.subscribe({ threadId }, terminalId));
        const snapshot = (yield* awaitKind(second, "snapshot")).item;
        if (snapshot.kind !== "snapshot") throw new Error("expected a snapshot");
        expect(snapshot.data).toMatch(line("42"));
        expect(snapshot.offset).toBeGreaterThanOrEqual(Math.max(...seenByFirst));

        // Both transcripts agree up to a later marker: the snapshot neither
        // repeats nor skips what the live stream delivers after it.
        yield* terminals.write({ threadId }, terminalId, "echo done-$((1+1))\n");
        const a = (yield* awaitText(first, line("done-2"))).text;
        const b = (yield* awaitText(second, line("done-2"))).text;
        expect(b.slice(0, b.search(line("done-2")))).toBe(a.slice(0, a.search(line("done-2"))));
      }),
    ),
  );

  it.live("resizes the terminal the shell sees", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId } = yield* withTerminal;
        const output = yield* watch(terminals.subscribe({ threadId }, terminalId));
        yield* terminals.resize({ threadId }, terminalId, 100, 30);
        yield* terminals.write({ threadId }, terminalId, "stty size\n");
        yield* awaitText(output, line("30 100"));
        const [summary] = yield* terminals.list({ threadId });
        expect(summary).toMatchObject({ cols: 100, rows: 30 });
      }),
    ),
  );

  it.live("opens the same id once, resizing it when asked at a new size", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId, opened } = yield* withTerminal;
        const again = yield* terminals.open({ threadId, terminalId, cols: 120, rows: 40 });
        expect(again.pid).toBe(opened.pid);
        expect(again).toMatchObject({ cols: 120, rows: 40 });
        expect(yield* terminals.list({ threadId })).toHaveLength(1);
      }),
    ),
  );

  it.live("holds each thread to its terminal limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId } = yield* withTerminal;
        for (let i = 1; i < TERMINALS_PER_OWNER; i++) {
          yield* terminals.open({ threadId, terminalId: makeTerminalId(), ...SIZE });
        }
        const listed = yield* terminals.list({ threadId });
        expect(listed).toHaveLength(TERMINALS_PER_OWNER);
        expect(listed[0]!.terminalId).toBe(terminalId);
        expect(
          yield* failureCode(
            terminals.open({ threadId, terminalId: makeTerminalId(), title: "one more", ...SIZE }),
          ),
        ).toBe("conflict");
      }),
    ),
  );

  it.live("keeps an exited shell listed, with its output, until it is closed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId } = yield* withTerminal;
        const output = yield* watch(terminals.subscribe({ threadId }, terminalId));
        yield* terminals.write({ threadId }, terminalId, "echo bye-$((2*3)); exit 3\n");
        const exited = (yield* awaitKind(output, "exited")).item;
        expect(exited).toEqual({ kind: "exited", exitCode: 3, signal: null });
        yield* output.awaitDone;
        expect((yield* output.collected).at(-1)?.text).toMatch(line("bye-6"));

        const [summary] = yield* terminals.list({ threadId });
        expect(summary).toMatchObject({ terminalId, status: "exited", exitCode: 3 });
        // Writing to it is harmless; the terminal is still there to read.
        yield* terminals.write({ threadId }, terminalId, "echo nobody\n");

        const late = yield* watch(terminals.subscribe({ threadId }, terminalId));
        yield* late.awaitDone;
        const items = (yield* late.collected).map(({ item }) => item);
        expect(items.map((item) => item.kind)).toEqual(["snapshot", "exited"]);
        expect(items[0]!.kind === "snapshot" && items[0]!.data).toMatch(line("bye-6"));
      }),
    ),
  );

  it.live("runs a script as the shell's own process and ends with it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* buildStack;
        const spawned: Array<{ file: string; args: ReadonlyArray<string> }> = [];
        const capture: typeof spawnPty = (options) => {
          spawned.push({ file: options.file, args: options.args });
          return spawnPty(options);
        };
        const terminals = yield* stack.service(yield* Effect.scope, capture);
        const threadId = yield* stack.thread;
        const terminalId = makeTerminalId();
        const command = "echo run-$((1+2)); exit 3";
        const script = { id: "dev", name: "dev server" };
        const opened = yield* terminals.open({
          threadId,
          terminalId,
          ...SIZE,
          script: { ...script, command },
        });
        expect(spawned).toEqual([{ file: "/bin/sh", args: ["-c", command] }]);
        expect(opened).toMatchObject({ title: "dev server", script });
        expect(opened).not.toHaveProperty("script.command");

        const output = yield* watch(terminals.subscribe({ threadId }, terminalId));
        const exited = (yield* awaitKind(output, "exited")).item;
        expect(exited).toEqual({ kind: "exited", exitCode: 3, signal: null });
        expect((yield* output.collected).at(-1)?.text).toMatch(line("run-3"));

        const [summary] = yield* terminals.list({ threadId });
        expect(summary).toMatchObject({ terminalId, script, status: "exited", exitCode: 3 });
        // Opening the same id again answers the terminal that is there.
        const again = yield* terminals.open({
          threadId,
          terminalId,
          ...SIZE,
          script: { ...script, command: "echo other" },
        });
        expect(again.pid).toBe(opened.pid);
        expect(spawned).toHaveLength(1);
      }),
    ),
  );

  it.live("an interactive shell's summary names no script", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { opened } = yield* withTerminal;
        expect(opened).not.toHaveProperty("script");
      }),
    ),
  );

  it.live("close ends the shell and forgets the terminal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId } = yield* withTerminal;
        const output = yield* watch(terminals.subscribe({ threadId }, terminalId));
        yield* awaitKind(output, "snapshot");
        yield* terminals.close({ threadId }, terminalId);
        yield* awaitKind(output, "exited");
        yield* output.awaitDone;
        expect(yield* terminals.list({ threadId })).toEqual([]);
        expect(yield* failureCode(terminals.close({ threadId }, terminalId))).toBe("not-found");
      }),
    ),
  );

  it.live(
    "a close interrupted while the shell ignores SIGHUP still ends it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stack = yield* buildStack;
          const exits: Array<Deferred.Deferred<PtyExit>> = [];
          const capture: typeof spawnPty = (options) =>
            Effect.tap(spawnPty(options), (pty) =>
              Effect.sync(() => {
                const exit = Deferred.makeUnsafe<PtyExit>();
                pty.onExit((result) => Deferred.doneUnsafe(exit, Effect.succeed(result)));
                exits.push(exit);
              }),
            );
          const terminals = yield* stack.service(yield* Effect.scope, capture);
          const threadId = yield* stack.thread;
          const terminalId = makeTerminalId();
          yield* terminals.open({ threadId, terminalId, ...SIZE });
          const output = yield* watch(terminals.subscribe({ threadId }, terminalId));
          yield* terminals.write({ threadId }, terminalId, "trap '' HUP; echo trapped-$((1+1))\n");
          yield* awaitText(output, line("trapped-2"));

          // Started at once, the close runs up to its wait for the exit after
          // SIGHUP; the interrupt then lands where a client's would — and
          // must wait for the SIGKILL rather than cut the kill short.
          const closing = yield* Effect.forkChild(terminals.close({ threadId }, terminalId), {
            startImmediately: true,
          });
          expect(yield* terminals.list({ threadId })).toEqual([]);
          yield* Fiber.interrupt(closing);
          expect(yield* Deferred.isDone(exits[0]!)).toBe(true);
          expect((yield* Deferred.await(exits[0]!)).signal).not.toBeNull();
        }),
      ),
    15_000,
  );

  for (const command of ["thread.delete", "thread.archive"] as const) {
    it.live(`${command} ends that thread's shells and no other's`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { engine, terminals, threadId, terminalId, thread } = yield* withTerminal;
          const otherThread = yield* thread;
          const otherTerminal = makeTerminalId();
          yield* terminals.open({ threadId: otherThread, terminalId: otherTerminal, ...SIZE });
          const doomed = yield* watch(terminals.subscribe({ threadId }, terminalId));
          const kept = yield* watch(terminals.subscribe({ threadId: otherThread }, otherTerminal));
          yield* awaitKind(doomed, "snapshot");

          yield* engine.dispatch({
            commandId: makeCommandId(),
            createdAt: NOW,
            type: command,
            threadId,
          });
          yield* awaitKind(doomed, "exited");
          expect(yield* terminals.list({ threadId })).toEqual([]);

          yield* terminals.write({ threadId: otherThread }, otherTerminal, "echo $((40+2))\n");
          yield* awaitText(kept, line("42"));
          const [survivor] = yield* terminals.list({ threadId: otherThread });
          expect(survivor).toMatchObject({ terminalId: otherTerminal, status: "running" });
        }),
      ),
    );
  }

  it.live("closing the service's scope ends every shell", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* buildStack;
        const spawned: Array<PtyProcess> = [];
        const exits: Array<Deferred.Deferred<PtyExit>> = [];
        const capture: typeof spawnPty = (options) =>
          Effect.tap(spawnPty(options), (pty) =>
            Effect.sync(() => {
              const exit = Deferred.makeUnsafe<PtyExit>();
              pty.onExit((result) => Deferred.doneUnsafe(exit, Effect.succeed(result)));
              spawned.push(pty);
              exits.push(exit);
            }),
          );
        const scope = yield* Scope.make();
        const terminals = yield* stack.service(scope, capture);
        const threadId = yield* stack.thread;
        const terminalId = makeTerminalId();
        yield* terminals.open({ threadId, terminalId, ...SIZE });
        const output = yield* watch(terminals.subscribe({ threadId }, terminalId));
        yield* terminals.write({ threadId }, terminalId, "echo $((20+22))\n");
        yield* awaitText(output, line("42"));

        yield* Scope.close(scope, Exit.void);
        expect(spawned).toHaveLength(1);
        const exit = yield* Deferred.await(exits[0]!);
        expect(exit.signal).not.toBeNull();
      }),
    ),
  );

  it.live("answers not-found for a terminal that is unknown or another thread's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId, thread } = yield* withTerminal;
        const otherThread = yield* thread;
        const unknown = makeTerminalId();
        expect(yield* failureCode(terminals.write({ threadId }, unknown, "x"))).toBe("not-found");
        expect(yield* failureCode(terminals.resize({ threadId }, unknown, 80, 24))).toBe(
          "not-found",
        );
        expect(yield* failureCode(terminals.close({ threadId }, unknown))).toBe("not-found");
        expect(
          yield* failureCode(Stream.runDrain(terminals.subscribe({ threadId }, unknown))),
        ).toBe("not-found");
        expect(
          yield* failureCode(terminals.write({ threadId: otherThread }, terminalId, "x")),
        ).toBe("not-found");
        expect(
          yield* failureCode(terminals.open({ threadId: otherThread, terminalId, ...SIZE })),
        ).toBe("conflict");
      }),
    ),
  );
});

describe.skipIf(process.platform === "win32")("TerminalService, owned by a project", () => {
  const removeProject = (stack: Stack) =>
    stack.engine
      .dispatch({
        commandId: makeCommandId(),
        createdAt: NOW,
        type: "project.remove",
        projectId: stack.projectId,
      })
      .pipe(Effect.orDie);

  it.live("starts the shell in the project's folder, with no thread at all", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* buildStack;
        const terminals = yield* stack.service(yield* Effect.scope);
        const owner = { projectId: stack.projectId };
        const terminalId = makeTerminalId();
        const opened = yield* terminals.open({ ...owner, terminalId, ...SIZE });
        expect(opened).toMatchObject({ terminalId, projectId: stack.projectId, status: "running" });
        expect(opened).not.toHaveProperty("threadId");

        const output = yield* watch(terminals.subscribe(owner, terminalId));
        yield* terminals.write(owner, terminalId, "pwd -P\n");
        yield* awaitText(output, line(realpathSync(stack.workspace)));
        expect(yield* terminals.list(owner)).toHaveLength(1);
      }),
    ),
  );

  it.live("keeps a project's terminals apart from its threads'", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId, projectId } = yield* withTerminal;
        const projectTerminal = makeTerminalId();
        yield* terminals.open({ projectId, terminalId: projectTerminal, ...SIZE });

        const idsOf = (listed: ReadonlyArray<{ readonly terminalId: string }>) =>
          listed.map((summary) => summary.terminalId);
        expect(idsOf(yield* terminals.list({ threadId }))).toEqual([terminalId]);
        expect(idsOf(yield* terminals.list({ projectId }))).toEqual([projectTerminal]);
        // Neither owner reaches the other's terminal, and neither can claim its id.
        expect(yield* failureCode(terminals.write({ threadId }, projectTerminal, "x"))).toBe(
          "not-found",
        );
        expect(yield* failureCode(terminals.write({ projectId }, terminalId, "x"))).toBe(
          "not-found",
        );
        expect(yield* failureCode(terminals.open({ projectId, terminalId, ...SIZE }))).toBe(
          "conflict",
        );
      }),
    ),
  );

  it.live("lists every thread's running terminals, and no project's or exited one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, terminalId, projectId } = yield* withTerminal;
        yield* terminals.open({ projectId, terminalId: makeTerminalId(), ...SIZE });
        const done = makeTerminalId();
        yield* terminals.open({ threadId, terminalId: done, ...SIZE });
        const finished = yield* watch(terminals.subscribe({ threadId }, done));
        yield* terminals.write({ threadId }, done, "exit 0\n");
        yield* awaitKind(finished, "exited");

        const running = yield* terminals.listRunning();
        expect(running.map((summary) => summary.terminalId)).toEqual([terminalId]);
        expect(running[0]).toMatchObject({ threadId, status: "running" });
      }),
    ),
  );

  it.live("starts a home terminal in the home folder, apart from every other owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { terminals, threadId, projectId, home } = yield* withTerminal;
        const owner = { home: true as const };
        const terminalId = makeTerminalId();
        const opened = yield* terminals.open({ ...owner, terminalId, ...SIZE });
        expect(opened).toMatchObject({ terminalId, home: true, status: "running" });
        expect(opened).not.toHaveProperty("threadId");
        expect(opened).not.toHaveProperty("projectId");

        const output = yield* watch(terminals.subscribe(owner, terminalId));
        yield* terminals.write(owner, terminalId, "pwd -P\n");
        yield* awaitText(output, line(realpathSync(home)));
        expect((yield* terminals.list(owner)).map((summary) => summary.terminalId)).toEqual([
          terminalId,
        ]);
        // No other owner reaches it, it is not a thread's running terminal,
        // and closing it forgets it.
        expect(yield* failureCode(terminals.write({ threadId }, terminalId, "x"))).toBe(
          "not-found",
        );
        expect(yield* failureCode(terminals.write({ projectId }, terminalId, "x"))).toBe(
          "not-found",
        );
        expect(
          (yield* terminals.listRunning()).some((summary) => summary.terminalId === terminalId),
        ).toBe(false);
        yield* terminals.close(owner, terminalId);
        yield* awaitKind(output, "exited");
        expect(yield* terminals.list(owner)).toEqual([]);
      }),
    ),
  );

  it.live("runs a script in the home folder and shows its exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* buildStack;
        const terminals = yield* stack.service(yield* Effect.scope);
        const owner = { home: true as const };
        const terminalId = makeTerminalId();
        const script = { id: "setup", name: "Setup", command: "pwd -P; exit 3" };
        const opened = yield* terminals.open({ ...owner, terminalId, ...SIZE, script });
        expect(opened).toMatchObject({ home: true, script: { id: "setup", name: "Setup" } });
        const output = yield* watch(terminals.subscribe(owner, terminalId));
        yield* awaitText(output, line(realpathSync(stack.home)));
        yield* awaitKind(output, "exited");
        expect(yield* terminals.list(owner)).toEqual([
          expect.objectContaining({ status: "exited", exitCode: 3 }),
        ]);
      }),
    ),
  );

  it.live("holds a project to the same terminal limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* buildStack;
        const terminals = yield* stack.service(yield* Effect.scope);
        const owner = { projectId: stack.projectId };
        for (let i = 0; i < TERMINALS_PER_OWNER; i++) {
          yield* terminals.open({ ...owner, terminalId: makeTerminalId(), ...SIZE });
        }
        const refused = yield* Effect.flip(
          terminals.open({ ...owner, terminalId: makeTerminalId(), ...SIZE }),
        );
        expect(refused).toMatchObject({
          code: "conflict",
          message: `this project already has ${TERMINALS_PER_OWNER} terminals; close one to open another`,
        });
      }),
    ),
  );

  it.live("project.remove ends the project's shells", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* buildStack;
        const terminals = yield* stack.service(yield* Effect.scope);
        const owner = { projectId: stack.projectId };
        const terminalId = makeTerminalId();
        yield* terminals.open({ ...owner, terminalId, ...SIZE });
        const doomed = yield* watch(terminals.subscribe(owner, terminalId));
        yield* awaitKind(doomed, "snapshot");

        yield* removeProject(stack);
        yield* awaitKind(doomed, "exited");
        expect(yield* terminals.list(owner)).toEqual([]);
      }),
    ),
  );

  it.live("workspaceOf starts a project in its folder, and refuses one gone or removed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* buildStack;
        const resolve = workspaceOf(stack.engine);
        expect(yield* failureCode(resolve({ projectId: makeProjectId() }))).toBe("not-found");
        expect(yield* Effect.orDie(resolve({ projectId: stack.projectId }))).toBe(stack.workspace);

        rmSync(stack.workspace, { recursive: true, force: true });
        expect(yield* Effect.flip(resolve({ projectId: stack.projectId }))).toMatchObject({
          code: "invalid",
          message: "the project folder no longer exists",
        });
        yield* removeProject(stack);
        expect(yield* failureCode(resolve({ projectId: stack.projectId }))).toBe("not-found");
      }),
    ),
  );
});

describe.skipIf(process.platform === "win32")(
  "TerminalService, handing a project's terminals over",
  () => {
    /** A stack, a service in the calling scope, and the project as a terminal owner. */
    const handOverStack = Effect.gen(function* () {
      const stack = yield* buildStack;
      const terminals = yield* stack.service(yield* Effect.scope);
      const project = { projectId: stack.projectId };
      const openInProject = (terminalId = makeTerminalId()) =>
        Effect.as(terminals.open({ ...project, terminalId, ...SIZE }), terminalId);
      return { ...stack, terminals, project, openInProject };
    });

    const idsOf = (listed: ReadonlyArray<{ readonly terminalId: string }>) =>
      listed.map((summary) => summary.terminalId);

    it.live("gives a local thread every terminal, running or exited, with its output", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { terminals, project, openInProject, thread, projectId } = yield* handOverStack;
          const running = yield* openInProject();
          const done = yield* openInProject();
          const output = yield* watch(terminals.subscribe(project, running));
          yield* terminals.write(project, running, "echo before-$((1+1))\n");
          yield* awaitText(output, line("before-2"));
          const finished = yield* watch(terminals.subscribe(project, done));
          yield* terminals.write(project, done, "exit 4\n");
          yield* awaitKind(finished, "exited");

          const threadId = yield* thread;
          const moved = yield* terminals.adopt(projectId, threadId);
          expect(idsOf(moved)).toEqual([running, done]);
          for (const summary of moved) {
            expect(summary.threadId).toBe(threadId);
            expect(summary).not.toHaveProperty("projectId");
          }
          expect(moved[1]).toMatchObject({ status: "exited", exitCode: 4 });
          expect(yield* terminals.list(project)).toEqual([]);
          expect(idsOf(yield* terminals.list({ threadId }))).toEqual([running, done]);

          // Under the thread, the same shell with the same scrollback; the
          // project no longer reaches it.
          const again = yield* watch(terminals.subscribe({ threadId }, running));
          const snapshot = (yield* awaitKind(again, "snapshot")).item;
          expect(snapshot.kind === "snapshot" && snapshot.data).toMatch(line("before-2"));
          expect(snapshot.kind === "snapshot" && snapshot.terminal.threadId).toBe(threadId);
          expect(yield* failureCode(terminals.write(project, running, "x"))).toBe("not-found");
        }),
      ),
    );

    it.live(
      "keeps a live subscriber streaming across the hand-over, nothing lost or repeated",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { terminals, project, openInProject, thread, projectId } = yield* handOverStack;
            const terminalId = yield* openInProject();
            const before = yield* watch(terminals.subscribe(project, terminalId));
            yield* terminals.write(project, terminalId, "echo one-$((1+1))\n");
            yield* awaitText(before, line("one-2"));

            const threadId = yield* thread;
            yield* terminals.adopt(projectId, threadId);
            const after = yield* watch(terminals.subscribe({ threadId }, terminalId));
            yield* terminals.write({ threadId }, terminalId, "echo two-$((2+2))\n");

            // The subscriber from before the hand-over sees the new output too,
            // and both transcripts agree up to it.
            const a = (yield* awaitText(before, line("two-4"))).text;
            const b = (yield* awaitText(after, line("two-4"))).text;
            expect(b.slice(0, b.search(line("two-4")))).toBe(a.slice(0, a.search(line("two-4"))));
            const offsets = (yield* before.collected).flatMap(({ item }) =>
              item.kind === "output" ? [item.offset] : [],
            );
            expect(offsets).toEqual([...offsets].sort((x, y) => x - y));
            expect(new Set(offsets).size).toBe(offsets.length);
          }),
        ),
    );

    it.live("refuses a thread in a worktree, another project's, or one that is gone", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stack = yield* handOverStack;
          const { terminals, project, openInProject, engine, projectId } = stack;
          const terminalId = yield* openInProject();

          const inWorktree = yield* stack.worktreeThread(yield* tempDir("worktree"));
          const otherProject = makeProjectId();
          const elsewhere = makeThreadId();
          yield* engine
            .dispatch({
              commandId: makeCommandId(),
              createdAt: NOW,
              type: "project.create",
              projectId: otherProject,
              name: "other",
              workspaceRoot: yield* tempDir("other"),
            })
            .pipe(Effect.orDie);
          yield* engine
            .dispatch({
              commandId: makeCommandId(),
              createdAt: NOW,
              type: "thread.create",
              threadId: elsewhere,
              projectId: otherProject,
              settings: { model: "fake/model" },
            })
            .pipe(Effect.orDie);
          const archived = yield* stack.thread;
          yield* engine
            .dispatch({
              commandId: makeCommandId(),
              createdAt: NOW,
              type: "thread.archive",
              threadId: archived,
            })
            .pipe(Effect.orDie);

          expect(yield* failureCode(terminals.adopt(projectId, inWorktree))).toBe("invalid");
          expect(yield* failureCode(terminals.adopt(projectId, elsewhere))).toBe("invalid");
          expect(yield* failureCode(terminals.adopt(projectId, archived))).toBe("invalid");
          expect(yield* failureCode(terminals.adopt(projectId, makeThreadId()))).toBe("not-found");
          expect(idsOf(yield* terminals.list(project))).toEqual([terminalId]);
        }),
      ),
    );

    it.live("refuses a project that is missing or removed", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { terminals, thread, projectId, engine } = yield* handOverStack;
          const threadId = yield* thread;
          expect(yield* failureCode(terminals.adopt(makeProjectId(), threadId))).toBe("not-found");
          yield* engine
            .dispatch({
              commandId: makeCommandId(),
              createdAt: NOW,
              type: "project.remove",
              projectId,
            })
            .pipe(Effect.orDie);
          expect(yield* failureCode(terminals.adopt(projectId, threadId))).toBe("not-found");
        }),
      ),
    );

    it.live("refuses a thread that has already started a turn", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { terminals, project, openInProject, thread, projectId, engine } =
            yield* handOverStack;
          const terminalId = yield* openInProject();
          const threadId = yield* thread;
          const receipt = yield* engine
            .dispatch({
              commandId: makeCommandId(),
              createdAt: NOW,
              type: "thread.turn.start",
              threadId,
              text: "go",
              attachments: [],
              mentions: [],
              queued: false,
            })
            .pipe(Effect.orDie);
          expect(receipt.status).toBe("accepted");
          expect(yield* failureCode(terminals.adopt(projectId, threadId))).toBe("invalid");
          expect(idsOf(yield* terminals.list(project))).toEqual([terminalId]);
          expect(yield* terminals.list({ threadId })).toEqual([]);
        }),
      ),
    );

    it.live("answers nothing when the project has no terminals", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { terminals, thread, projectId } = yield* handOverStack;
          const threadId = yield* thread;
          expect(yield* terminals.adopt(projectId, threadId)).toEqual([]);
          expect(yield* terminals.list({ threadId })).toEqual([]);
        }),
      ),
    );

    it.live("moves nothing when the thread would pass the terminal limit", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { terminals, project, openInProject, thread, projectId } = yield* handOverStack;
          const threadId = yield* thread;
          for (let i = 0; i < TERMINALS_PER_OWNER - 1; i++) {
            yield* terminals.open({ threadId, terminalId: makeTerminalId(), ...SIZE });
          }
          const first = yield* openInProject();
          const second = yield* openInProject();
          expect(yield* failureCode(terminals.adopt(projectId, threadId))).toBe("conflict");
          expect(idsOf(yield* terminals.list(project))).toEqual([first, second]);
          expect(yield* terminals.list({ threadId })).toHaveLength(TERMINALS_PER_OWNER - 1);
        }),
      ),
    );

    it.live("never leaves a terminal with both owners or with neither, under a racing open", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { terminals, project, openInProject, thread, projectId } = yield* handOverStack;
          const threadId = yield* thread;
          const existing = [yield* openInProject(), yield* openInProject()];
          const racing = makeTerminalId();
          yield* Effect.all([terminals.adopt(projectId, threadId), openInProject(racing)], {
            concurrency: "unbounded",
          });
          const byProject = idsOf(yield* terminals.list(project));
          const byThread = idsOf(yield* terminals.list({ threadId }));
          const all = [...byProject, ...byThread];
          expect(new Set(all).size).toBe(all.length);
          expect([...all].sort()).toEqual([...existing, racing].sort());
          for (const terminalId of existing) {
            expect(byThread).toContain(terminalId);
          }
        }),
      ),
    );
  },
);

describe("workspaceOf", () => {
  it.live("refuses an archived thread until it is unarchived", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* buildStack;
        const resolve = workspaceOf(stack.engine);
        const threadId = yield* stack.thread;
        const toggle = (type: "thread.archive" | "thread.unarchive") =>
          stack.engine
            .dispatch({ commandId: makeCommandId(), createdAt: NOW, type, threadId })
            .pipe(Effect.orDie);
        yield* toggle("thread.archive");
        expect(yield* Effect.flip(resolve({ threadId }))).toMatchObject({
          code: "invalid",
          message: "the thread is archived; unarchive it to open a terminal",
        });
        yield* toggle("thread.unarchive");
        expect(yield* Effect.orDie(resolve({ threadId }))).toBe(stack.workspace);
      }),
    ),
  );

  it.live("starts a worktree thread in its worktree, and refuses it once that is gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* buildStack;
        const resolve = workspaceOf(stack.engine);
        const worktree = yield* tempDir("worktree");
        const threadId = yield* stack.worktreeThread(worktree);
        expect(yield* Effect.orDie(resolve({ threadId }))).toBe(worktree);
        rmSync(worktree, { recursive: true, force: true });
        expect(yield* Effect.flip(resolve({ threadId }))).toMatchObject({
          code: "invalid",
          message: "the thread's worktree no longer exists",
        });
      }),
    ),
  );

  it.live("refuses an unknown thread and a project folder that is gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* buildStack;
        const resolve = workspaceOf(stack.engine);
        expect(yield* failureCode(resolve({ threadId: makeThreadId() }))).toBe("not-found");

        const threadId = yield* stack.thread;
        expect(yield* Effect.orDie(resolve({ threadId }))).toBe(stack.workspace);
        rmSync(stack.workspace, { recursive: true, force: true });
        const error = yield* Effect.flip(resolve({ threadId }));
        expect(error).toMatchObject({
          code: "invalid",
          message: "the project folder no longer exists",
        });
      }),
    ),
  );
});

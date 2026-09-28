/**
 * The browser service over `makeFakeDriver` — no browser binary needed:
 *
 * - `browser_open → browser_snapshot → browser_click` walks a fake page and
 *   the subscribe stream tracks the url.
 * - Any human gesture during an in-flight call resolves it as `interrupted` —
 *   the epoch flip the MCP layer maps to `interrupted_by_human`. That includes
 *   a click during `browser_click`: CDP input is never relayed back, so there
 *   is no "the agent's own echo" to allow for.
 * - `disabled` answers every call with the kill-switch message and opens
 *   nothing.
 * - In-app, a `tab_gone` reaches the agent and the next call runs on the same
 *   in-app driver — never a fallback to owned Chromium — and the human's
 *   toolbar never opens a driver or runs agent-browser.
 * - A thread.delete dispatched through the engine reaches the teardown
 *   reactor and closes the driver.
 * - `teardown` stops the session and is idempotent.
 * - Sessions are per-thread.
 * - No daemon outlives what started it: closing the service's scope closes
 *   every driver, teardown waits for the call in flight before it closes, a
 *   command timeout closes the driver it hung on, and the boot reap finishes
 *   before the first driver opens.
 */

import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { makeCommandId, makeProjectId, makeThreadId } from "@poseidon/contracts/ids";

import { OrchestrationEngine } from "../orchestration/Engine";
import { EventStore } from "../persistence/EventStore";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { PermissionService } from "../permissions/PermissionService";
import { BrowserService } from "../rpc/services";
import { AgentBrowserError, BROWSER_DISABLED_MESSAGE, TIMEOUT_CODE } from "./agentBrowser";
import { makeService, type OpenDriverOptions } from "./BrowserService";
import type { BrowserDriver } from "./driver";
import { makeFakeDriver, type FakePage } from "./fakeDriver";
import { TAB_GONE_MESSAGE } from "./inAppDriver";
import { SCREENSHOT_TIMEOUT_MESSAGE } from "./tools";

const threadId = makeThreadId();
const NOW = "2026-01-02T03:04:05.000Z";

const fakePage = (): FakePage => ({
  url: "about:blank",
  title: "Blank",
  lines: [{ role: "link", name: "Docs", ref: "e1", url: "https://example.com/docs" }],
  history: [],
  historyIndex: -1,
});

const permissionsWith = (decide: PermissionService["Service"]["decide"]) =>
  Layer.succeed(
    PermissionService,
    PermissionService.of({ decide, rules: () => Effect.succeed([]), addRule: () => Effect.void }),
  );

const permissionsStub = permissionsWith(() => Effect.succeed("allow" as const));

type OpenDriver = (
  options: OpenDriverOptions,
) => Effect.Effect<BrowserDriver, { readonly message: string }, Scope.Scope>;

const buildStack = (
  openDriver: OpenDriver,
  mode: "in-app" | "owned-chromium" | "disabled" = "owned-chromium",
  reap?: Effect.Effect<void>,
  cli?: { readonly installed: boolean; readonly version: string | null },
  permissions: Layer.Layer<PermissionService> = permissionsStub,
) =>
  Effect.gen(function* () {
    const sqliteContext = yield* Layer.build(sqliteTestLayer());
    const sqlite = Layer.succeedContext(sqliteContext);
    const persistence = Layer.mergeAll(
      sqlite,
      Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
    );
    const engine = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
    const browser = Layer.effect(
      BrowserService,
      makeService({
        mode,
        openDriver,
        ...(reap === undefined ? {} : { reap }),
        ...(cli === undefined ? {} : { cli }),
      }),
    ).pipe(Layer.provide(Layer.mergeAll(engine, permissions)));
    const context = yield* Layer.build(Layer.mergeAll(engine, browser));
    return {
      browser: Context.get(context, BrowserService),
      engine: Context.get(context, OrchestrationEngine),
    };
  });

const currentState = (browser: BrowserService["Service"], id: typeof threadId) =>
  Stream.runHead(browser.subscribe(id)).pipe(
    Effect.map((head) => (Option.isSome(head) ? head.value : null)),
  );

describe("BrowserService", () => {
  it.live("open → snapshot → click drives a fake page and tracks the url", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser } = yield* buildStack(() => Effect.succeed(makeFakeDriver(fakePage())));

        const open = yield* browser.callTool(threadId, "browser_open", {
          url: "https://example.com",
        });
        expect(open.kind).toBe("ok");

        const state = yield* currentState(browser, threadId);
        expect(state?.status).toBe("ready");
        expect(state?.mode).toBe("owned-chromium");
        expect(state?.url).toBe("https://example.com");

        const snapshot = yield* browser.callTool(threadId, "browser_snapshot", {});
        expect(snapshot.kind).toBe("ok");
        if (snapshot.kind === "ok") {
          expect(String(snapshot.data.snapshot)).toContain("Docs");
        }

        const click = yield* browser.callTool(threadId, "browser_click", {
          selector: "@e1",
        });
        expect(click.kind).toBe("ok");

        const after = yield* currentState(browser, threadId);
        expect(after?.url).toBe("https://example.com/docs");
        expect(after?.activeTool).toBeFalsy();
      }),
    ),
  );

  it.live("a human gesture mid-call resolves the tool as interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              onExec: (argv) =>
                argv[0] === "eval"
                  ? Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release))
                  : Effect.void,
            }),
          ),
        );

        const call = yield* browser
          .callTool(threadId, "browser_eval", { js: "1 + 1" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);

        // Somebody clicks the page while the agent's eval runs.
        yield* browser.humanInput(threadId, { kind: "click", x: 3, y: 4 });
        yield* Deferred.succeed(release, undefined);

        const outcome = yield* Fiber.join(call);
        expect(outcome.kind).toBe("interrupted");
      }),
    ),
  );

  it.live("browser_wait on a JavaScript condition is gated like browser_eval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const asked: Array<string> = [];
        const execs: Array<ReadonlyArray<string>> = [];
        // What plan mode or a deny rule answers for a `web` request.
        const denyWeb = permissionsWith(({ request }) =>
          Effect.sync(() => {
            asked.push(request.toolName);
            return request.kind === "web" ? ("deny" as const) : ("allow" as const);
          }),
        );
        const { browser } = yield* buildStack(
          () =>
            Effect.succeed(
              makeFakeDriver(fakePage(), {
                onExec: (argv) => Effect.sync(() => void execs.push(argv)),
              }),
            ),
          "owned-chromium",
          undefined,
          undefined,
          denyWeb,
        );

        const byCondition = yield* browser.callTool(threadId, "browser_wait", {
          fn: "fetch('https://example.com/x')",
        });
        expect(byCondition.kind).toBe("error");
        const byEval = yield* browser.callTool(threadId, "browser_eval", { js: "1" });
        expect(byEval.kind).toBe("error");
        expect(asked).toEqual(["mcp__poseidon__browser_wait", "mcp__poseidon__browser_eval"]);
        expect(execs.some((argv) => argv.includes("--fn") || argv[0] === "eval")).toBe(false);

        // A plain wait runs no script and asks nothing.
        const byTime = yield* browser.callTool(threadId, "browser_wait", { ms: 1 });
        expect(byTime.kind).toBe("ok");
        expect(asked).toHaveLength(2);
      }),
    ),
  );

  it.live("a human click during browser_click interrupts it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The relay only ever reports a person: input the agent synthesizes
        // over CDP fires no before-input-event. So even a pointer gesture in
        // the middle of the agent's own click is the human taking over.
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { browser } = yield* buildStack(
          () =>
            Effect.succeed(
              makeFakeDriver(fakePage(), {
                mode: "in-app",
                onExec: (argv) =>
                  argv[0] === "click"
                    ? Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release))
                    : Effect.void,
              }),
            ),
          "in-app",
        );

        const call = yield* browser
          .callTool(threadId, "browser_click", { selector: "@e1" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* browser.humanInput(threadId, { kind: "click", x: 3, y: 4 });
        yield* Deferred.succeed(release, undefined);

        const outcome = yield* Fiber.join(call);
        expect(outcome).toEqual({ kind: "interrupted", status: "interrupted_by_human" });
      }),
    ),
  );

  it.live("a passive location sync is not the human", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { browser } = yield* buildStack(
          () =>
            Effect.succeed(
              makeFakeDriver(fakePage(), {
                mode: "in-app",
                onExec: (argv) =>
                  argv[0] === "open"
                    ? Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release))
                    : Effect.void,
              }),
            ),
          "in-app",
        );

        const call = yield* browser
          .callTool(threadId, "browser_open", { url: "https://example.com/" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        // The pane reports where the agent's navigation landed.
        yield* browser.humanInput(threadId, { kind: "location", url: "https://example.com/" });
        yield* Deferred.succeed(release, undefined);

        const outcome = yield* Fiber.join(call);
        expect(outcome.kind).toBe("ok");
      }),
    ),
  );

  it.live("sends the agent's browser only to http and https", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // `browser_open` took any string, so `file://` plus `browser_get text
        // body` read key material that `read_file` on the same path prompts
        // about — and nothing gated it the way `browser_eval` is gated.
        const argvs: Array<ReadonlyArray<string>> = [];
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              onExec: (argv) =>
                Effect.sync(() => {
                  argvs.push(argv);
                }),
            }),
          ),
        );

        for (const url of [
          "file:///Users/someone/.ssh/id_ed25519",
          "about:blank",
          "data:text/html,<script>fetch('/')</script>",
          "devtools://devtools/bundled/inspector.html",
        ]) {
          const refused = yield* browser.callTool(threadId, "browser_open", { url });
          expect(refused.kind).toBe("error");
          expect(refused.kind === "error" ? refused.message : "").toContain("http://");
        }
        const refusedTab = yield* browser.callTool(threadId, "browser_tabs", {
          action: "new",
          url: "file:///etc/passwd",
        });
        expect(refusedTab.kind).toBe("error");

        // Refused before anything ran, and the web still works.
        expect(argvs).toEqual([]);
        const opened = yield* browser.callTool(threadId, "browser_open", {
          url: "https://example.com/docs",
        });
        expect(opened.kind).toBe("ok");
        expect(argvs).toContainEqual(["open", "https://example.com/docs"]);
      }),
    ),
  );

  it.live("reports its mode and agent-browser's install state for settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const never = () => Effect.die("no driver");
        const installed = yield* buildStack(never, "in-app", undefined, {
          installed: true,
          version: "agent-browser 0.38.1",
        });
        expect(installed.browser.status).toEqual({
          mode: "in-app",
          installed: true,
          version: "agent-browser 0.38.1",
        });
        const missing = yield* buildStack(never, "owned-chromium", undefined, {
          installed: false,
          version: null,
        });
        expect(missing.browser.status).toEqual({
          mode: "owned-chromium",
          installed: false,
          version: null,
        });
        const blank = yield* buildStack(never, "disabled", undefined, {
          installed: true,
          version: "",
        });
        expect(blank.browser.status.version).toBe(null);
      }),
    ),
  );

  it.live("disabled answers every call and opens nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let opened = 0;
        const { browser } = yield* buildStack(
          () =>
            Effect.sync(() => {
              opened += 1;
              return makeFakeDriver(fakePage());
            }),
          "disabled",
        );

        const before = yield* currentState(browser, threadId);
        expect(before?.mode).toBe("disabled");
        expect(before?.message).toBe(BROWSER_DISABLED_MESSAGE);

        for (const [name, args] of [
          ["browser_open", { url: "https://example.com/" }],
          ["browser_snapshot", {}],
          ["browser_click", { selector: "@e1" }],
          ["browser_eval", { js: "1" }],
          ["browser_tabs", { action: "list" }],
        ] as const) {
          const outcome = yield* browser.callTool(threadId, name, args);
          expect(outcome).toEqual({ kind: "error", message: BROWSER_DISABLED_MESSAGE });
        }
        // Nor does the toolbar start anything.
        yield* browser.humanInput(threadId, { kind: "navigate", url: "https://example.com/" });
        yield* browser.humanInput(threadId, { kind: "history", direction: "reload" });
        expect(opened).toBe(0);
      }),
    ),
  );

  it.live("a closed tab reaches the agent, and the next call stays in-app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let opened = 0;
        let execs = 0;
        const { browser } = yield* buildStack(
          () =>
            Effect.sync(() => {
              opened += 1;
              return makeFakeDriver(fakePage(), {
                mode: "in-app",
                onExec: () => {
                  execs += 1;
                  // The in-app driver's own `tab_gone`, as it hands it over.
                  return execs === 1
                    ? new AgentBrowserError({
                        command: "tab_gone",
                        message: TAB_GONE_MESSAGE,
                        code: "tab_gone",
                        data: null,
                      })
                    : Effect.void;
                },
              });
            }),
          "in-app",
        );

        const first = yield* browser.callTool(threadId, "browser_snapshot", {});
        expect(first).toEqual({ kind: "error", message: TAB_GONE_MESSAGE });

        const second = yield* browser.callTool(threadId, "browser_snapshot", {});
        expect(second.kind).toBe("ok");
        // The same driver: nothing was released, reopened or swapped for
        // owned Chromium.
        expect(opened).toBe(1);
        const state = yield* currentState(browser, threadId);
        expect(state?.mode).toBe("in-app");
        expect(state?.status).toBe("ready");
      }),
    ),
  );

  it.live("a failed in-app attach is an error, never a headless browser", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let opened = 0;
        const { browser } = yield* buildStack(
          () =>
            Effect.suspend(() => {
              opened += 1;
              return Effect.fail({ message: "the Poseidon window is not open" });
            }),
          "in-app",
        );
        const outcome = yield* browser.callTool(threadId, "browser_snapshot", {});
        expect(outcome).toEqual({ kind: "error", message: "the Poseidon window is not open" });
        const state = yield* currentState(browser, threadId);
        expect(state?.status).toBe("error");
        expect(state?.mode).toBe("in-app");
        // The pane's Retry clears the alert and opens nothing; the agent's
        // next call tries the attach again.
        yield* browser.humanInput(threadId, { kind: "history", direction: "reload" });
        const retried = yield* currentState(browser, threadId);
        expect(retried?.status).toBe("stopped");
        expect(retried?.message).toBeUndefined();
        expect(opened).toBe(1);
        yield* browser.callTool(threadId, "browser_snapshot", {});
        expect(opened).toBe(2);
      }),
    ),
  );

  it.live("in-app, the toolbar never opens a driver or runs agent-browser", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let opened = 0;
        const argvs: Array<ReadonlyArray<string>> = [];
        const { browser } = yield* buildStack(
          () =>
            Effect.sync(() => {
              opened += 1;
              return makeFakeDriver(fakePage(), {
                mode: "in-app",
                onExec: (argv) =>
                  Effect.sync(() => {
                    argvs.push(argv);
                  }),
              });
            }),
          "in-app",
        );

        // Before any agent call: nothing starts.
        yield* browser.humanInput(threadId, { kind: "navigate", url: "https://example.com/a" });
        yield* browser.humanInput(threadId, { kind: "history", direction: "reload" });
        expect(opened).toBe(0);
        // The navigation is mirrored for the address bar all the same.
        expect((yield* currentState(browser, threadId))?.url).toBe("https://example.com/a");

        // With a driver open, the toolbar still does not go through it: a CDP
        // `reload` from here would reload the whole Poseidon window.
        yield* browser.callTool(threadId, "browser_snapshot", {});
        const ran = argvs.length;
        yield* browser.humanInput(threadId, { kind: "navigate", url: "https://example.com/b" });
        yield* browser.humanInput(threadId, { kind: "history", direction: "back" });
        yield* browser.humanInput(threadId, { kind: "history", direction: "reload" });
        yield* browser.humanInput(threadId, { kind: "history", direction: "stop" });
        yield* browser.humanInput(threadId, { kind: "click", x: 1, y: 2 });
        expect(argvs.length).toBe(ran);
        expect(opened).toBe(1);
      }),
    ),
  );

  it.live("browser_tabs manages the thread's tabs in-app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The bridge only ever shows agent-browser this thread's webviews, so
        // there is no app window among the tabs to keep the agent away from.
        const argvs: Array<ReadonlyArray<string>> = [];
        const { browser } = yield* buildStack(
          () =>
            Effect.succeed(
              makeFakeDriver(fakePage(), {
                mode: "in-app",
                onExec: (argv) =>
                  Effect.sync(() => {
                    argvs.push(argv);
                  }),
              }),
            ),
          "in-app",
        );
        for (const args of [
          { action: "list" },
          { action: "new", url: "https://example.com/" },
          { action: "switch", tab: "t2" },
          { action: "close", tab: "t2" },
        ]) {
          const outcome = yield* browser.callTool(threadId, "browser_tabs", args);
          expect(outcome.kind).toBe("ok");
        }
        expect(argvs).toContainEqual(["tab", "list"]);
        expect(argvs).toContainEqual(["tab", "new", "https://example.com/"]);
        expect(argvs).toContainEqual(["tab", "t2"]);
        expect(argvs).toContainEqual(["tab", "close", "t2"]);
      }),
    ),
  );

  it.live("owned Chromium's toolbar drives the page through the server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const argvs: Array<ReadonlyArray<string>> = [];
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              onExec: (argv) =>
                Effect.sync(() => {
                  argvs.push(argv);
                }),
            }),
          ),
        );

        // A navigate is enough to start the owned browser.
        yield* browser.humanInput(threadId, { kind: "navigate", url: "https://example.com/a" });
        yield* browser.humanInput(threadId, { kind: "navigate", url: "https://example.com/b" });
        yield* browser.humanInput(threadId, { kind: "history", direction: "back" });
        yield* browser.humanInput(threadId, { kind: "history", direction: "reload" });

        expect(argvs).toContainEqual(["open", "https://example.com/a"]);
        expect(argvs).toContainEqual(["open", "https://example.com/b"]);
        expect(argvs).toContainEqual(["back"]);
        expect(argvs).toContainEqual(["reload"]);
        // agent-browser has no stop: the gesture runs nothing.
        const ran = argvs.length;
        yield* browser.humanInput(threadId, { kind: "history", direction: "stop" });
        expect(argvs.length).toBe(ran);

        // `back` walked the page off the address the human typed last, and
        // the state followed the page rather than the toolbar's optimism.
        const state = yield* currentState(browser, threadId);
        expect(state?.url).toBe("https://example.com/a");
      }),
    ),
  );

  it.live("the driver's scope outlives the call that opened it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Stands in for the owned driver's frame-stream fiber: it is forked
        // into the open scope, so closing that scope at the end of the open
        // would kill the stream before a single frame arrived.
        let released = false;
        const { browser } = yield* buildStack(() =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                released = true;
              }),
            );
            return makeFakeDriver(fakePage());
          }),
        );

        yield* browser.callTool(threadId, "browser_open", { url: "https://example.com/a" });
        expect(released).toBe(false);

        yield* browser.teardown(threadId);
        expect(released).toBe(true);
      }),
    ),
  );

  it.live("teardown stops the session and is idempotent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closes = 0;
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              onClose: () =>
                Effect.sync(() => {
                  closes += 1;
                }),
            }),
          ),
        );

        yield* browser.callTool(threadId, "browser_open", { url: "https://example.com" });
        yield* browser.teardown(threadId);

        const state = yield* currentState(browser, threadId);
        expect(state?.status).toBe("stopped");
        expect(state?.url).toBeNull();
        expect(closes).toBe(1);

        yield* browser.teardown(threadId);
        expect(closes).toBe(1);
      }),
    ),
  );

  it.live("deleting the thread closes its browser through the engine's events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closed = yield* Deferred.make<void>();
        const { browser, engine } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), { onClose: () => Deferred.succeed(closed, undefined) }),
          ),
        );

        const projectId = makeProjectId();
        const ownThread = makeThreadId();
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "project.create",
          projectId,
          name: "demo",
          workspaceRoot: "/repo",
        });
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.create",
          threadId: ownThread,
          projectId,
          settings: { model: "fake/model" },
        });

        yield* browser.callTool(ownThread, "browser_open", { url: "https://example.com" });

        // The teardown path: the engine emits thread.deleted and the forked
        // reactor tears the browser down. No
        // one calls teardown() by hand.
        yield* engine.dispatch({
          commandId: makeCommandId(),
          createdAt: NOW,
          type: "thread.delete",
          threadId: ownThread,
        });
        yield* Deferred.await(closed);

        // The driver closed; the published state settles a moment later, so
        // wait for the stopped frame rather than sampling.
        const state = yield* Stream.runHead(
          browser.subscribe(ownThread).pipe(Stream.filter((next) => next.status === "stopped")),
        );
        expect(Option.isSome(state)).toBe(true);
      }),
    ),
  );

  it.live("sessions are per-thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const other = makeThreadId();
        const { browser } = yield* buildStack(() => Effect.succeed(makeFakeDriver(fakePage())));

        yield* browser.callTool(threadId, "browser_open", { url: "https://a.example" });
        const untouched = yield* currentState(browser, other);
        expect(untouched?.status).toBe("stopped");
        expect(untouched?.url).toBeNull();
      }),
    ),
  );
});

/** Lets every forked fiber run until it blocks on something. */
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
  discard: true,
});

describe("BrowserService daemon lifecycle", () => {
  it.live("closing the service's scope closes every open driver", () =>
    Effect.gen(function* () {
      const closed: Array<string> = [];
      const scope = yield* Scope.make();
      const { browser } = yield* Scope.provide(scope)(
        buildStack(({ threadId: id }) =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              onClose: () =>
                Effect.sync(() => {
                  closed.push(id);
                }),
            }),
          ),
        ),
      );
      const other = makeThreadId();
      yield* browser.callTool(threadId, "browser_open", { url: "https://a.example" });
      yield* browser.callTool(other, "browser_open", { url: "https://b.example" });
      expect(closed).toEqual([]);

      // The server shutting down.
      yield* Scope.close(scope, Exit.void);
      expect([...closed].sort()).toEqual([threadId, other].sort());
    }),
  );

  it.live("teardown waits for the call in flight before it closes the driver", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const order: Array<string> = [];
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { browser } = yield* buildStack(() =>
          Effect.succeed(
            makeFakeDriver(fakePage(), {
              onExec: (argv) =>
                argv[0] === "eval"
                  ? Effect.gen(function* () {
                      yield* Deferred.succeed(started, undefined);
                      yield* Deferred.await(release);
                      order.push("eval done");
                    })
                  : Effect.void,
              onClose: () =>
                Effect.sync(() => {
                  order.push("closed");
                }),
            }),
          ),
        );

        const call = yield* browser
          .callTool(threadId, "browser_eval", { js: "1" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const teardown = yield* browser.teardown(threadId).pipe(Effect.forkChild);
        yield* settle;
        // Still waiting its turn: the daemon is mid-command.
        expect(order).toEqual([]);

        yield* Deferred.succeed(release, undefined);
        const outcome = yield* Fiber.join(call);
        yield* Fiber.join(teardown);
        expect(outcome.kind).toBe("ok");
        expect(order).toEqual(["eval done", "closed"]);
      }),
    ),
  );

  it.live("a call queued behind teardown opens no driver", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let opened = 0;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { browser } = yield* buildStack(() =>
          Effect.sync(() => {
            opened += 1;
            return makeFakeDriver(fakePage(), {
              onExec: (argv) =>
                argv[0] === "eval"
                  ? Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release))
                  : Effect.void,
            });
          }),
        );

        const first = yield* browser
          .callTool(threadId, "browser_eval", { js: "1" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const teardown = yield* browser.teardown(threadId).pipe(Effect.forkChild);
        yield* settle;
        const queued = yield* browser
          .callTool(threadId, "browser_snapshot", {})
          .pipe(Effect.forkChild);
        yield* settle;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(teardown);

        const outcome = yield* Fiber.join(queued);
        expect(outcome.kind).toBe("error");
        expect(opened).toBe(1);
      }),
    ),
  );

  it.live("a command timeout closes the driver, and the next call opens a fresh one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let opened = 0;
        let closes = 0;
        const timeouts: Array<number | undefined> = [];
        const { browser } = yield* buildStack(
          () =>
            Effect.sync(() => {
              opened += 1;
              return makeFakeDriver(fakePage(), {
                mode: "in-app",
                onExec: (argv, options) =>
                  argv[0] === "screenshot" && opened === 1
                    ? Effect.andThen(
                        Effect.sync(() => {
                          timeouts.push(options?.timeoutMs);
                        }),
                        // What the session's exec fails with once the CLI
                        // child has been killed for running out of time.
                        new AgentBrowserError({
                          command: "agent-browser screenshot",
                          message: "agent-browser screenshot timed out after 15s",
                          code: TIMEOUT_CODE,
                          data: null,
                        }),
                      )
                    : Effect.void,
                onClose: () =>
                  Effect.sync(() => {
                    closes += 1;
                  }),
              });
            }),
          "in-app",
        );

        const shot = yield* browser.callTool(threadId, "browser_screenshot", {});
        // An unpainted guest is the usual reason, so the agent is told that.
        expect(shot).toEqual({ kind: "error", message: SCREENSHOT_TIMEOUT_MESSAGE });
        expect(timeouts).toEqual([15_000]);
        expect(closes).toBe(1);
        const state = yield* currentState(browser, threadId);
        expect(state?.status).toBe("error");
        expect(state?.message).toBe(SCREENSHOT_TIMEOUT_MESSAGE);

        const next = yield* browser.callTool(threadId, "browser_snapshot", {});
        expect(next.kind).toBe("ok");
        expect(opened).toBe(2);
        expect((yield* currentState(browser, threadId))?.status).toBe("ready");
      }),
    ),
  );

  it.live("the first driver waits for the boot reap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const order: Array<string> = [];
        const reapStarted = yield* Deferred.make<void>();
        const reapRelease = yield* Deferred.make<void>();
        const reap = Effect.gen(function* () {
          yield* Deferred.succeed(reapStarted, undefined);
          yield* Deferred.await(reapRelease);
          order.push("reaped");
        });
        const { browser } = yield* buildStack(
          () =>
            Effect.sync(() => {
              order.push("opened");
              return makeFakeDriver(fakePage());
            }),
          "owned-chromium",
          reap,
        );

        // The build did not wait for the reap.
        yield* Deferred.await(reapStarted);
        const call = yield* browser
          .callTool(threadId, "browser_open", { url: "https://a.example" })
          .pipe(Effect.forkChild);
        yield* settle;
        expect(order).toEqual([]);

        yield* Deferred.succeed(reapRelease, undefined);
        expect((yield* Fiber.join(call)).kind).toBe("ok");
        expect(order).toEqual(["reaped", "opened"]);
      }),
    ),
  );
});

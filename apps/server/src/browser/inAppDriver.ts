/**
 * The in-app driver: agent-browser drives the thread's own pane webviews
 * through the desktop's browser bridge.
 *
 * The session's `AGENT_BROWSER_CDP` is the thread's bridge URL (see
 * `./agentBrowser`), and the bridge lists only that thread's webviews, so
 * every target the daemon can see is one the pane shows. Attaching is:
 *
 * 1. `tab list` — connecting. On a thread with no webview yet, agent-browser
 *    itself calls `Target.createTarget(about:blank)` as it connects, which the
 *    bridge turns into a new pane tab: that is how the first browser call
 *    creates the thread's webview. A list that comes back empty on a live
 *    connection (the pane closed every tab) gets a `tab new`.
 * 2. `--pin-tab tab <targetId>` of the first listed tab. A pinned session
 *    fails with `tab_gone` when its tab is destroyed, instead of quietly
 *    driving whichever tab is left.
 * 3. `stream disable`. The daemon opens an unauthenticated loopback frame
 *    stream by default; in-app mode has no use for it, so it goes.
 *
 * A `tab_gone` reaches the agent as an error and drops the binding; the next
 * call attaches again, to the pane's current tab. The call that hit it is not
 * retried on another tab behind the agent's back.
 *
 * Every sequence here is recorded against the real bridge in
 * `packages/testkit/fixtures/agent-browser/cli-*`, and the tests replay them.
 */

import * as Effect from "effect/Effect";

import {
  AgentBrowserError,
  IDLE_TIMEOUT_MS,
  type AgentBrowserSession,
  type AgentBrowserUnavailable,
} from "./agentBrowser";
import { locationOf, readTabs, type BrowserDriver } from "./driver";

/** What the agent reads when the pane closed the tab it was driving. */
export const TAB_GONE_MESSAGE =
  "the browser tab you were driving was closed in the pane; the next call uses the pane's current tab";

type ExecError = AgentBrowserError | AgentBrowserUnavailable;

const isTabGone = (error: ExecError): boolean =>
  error._tag === "AgentBrowserError" && error.code === "tab_gone";

/**
 * `stream disable` on a daemon whose stream is already off fails with
 * "Streaming is not enabled for this session" — which is the state we want.
 */
const isStreamOff = (error: ExecError): boolean =>
  error._tag === "AgentBrowserError" && /not enabled/i.test(error.message);

/**
 * How long a gap between commands means the daemon may have reaped itself.
 * Shorter than the idle timeout the session's env gives the daemon: the gap
 * is measured from when the CLI child exited, which is after the daemon's own
 * last activity, so at exactly the timeout the daemon can already be gone.
 */
export const REPIN_AFTER_IDLE_MS = IDLE_TIMEOUT_MS - 30_000;

export interface InAppDriverOptions {
  /**
   * How long a gap between commands means the daemon may have reaped itself,
   * so the driver attaches again before the next one: the pin and the
   * disabled stream are daemon state, and a resurrected daemon has neither.
   * Defaults to `REPIN_AFTER_IDLE_MS`.
   */
  readonly reattachAfterIdleMs?: number;
}

export const openInAppDriver = (
  session: AgentBrowserSession,
  options: InAppDriverOptions = {},
): Effect.Effect<BrowserDriver, ExecError> =>
  Effect.gen(function* () {
    /** The pinned tab, or `null` when the next call has to attach first. */
    const bound = { current: null as string | null };
    const lastExecAt = { current: null as number | null };
    const idleMs = options.reattachAfterIdleMs ?? REPIN_AFTER_IDLE_MS;
    const now = Effect.clockWith((clock) => clock.currentTimeMillis);

    const pin = (targetId: string) =>
      Effect.gen(function* () {
        yield* session.exec(["--pin-tab", "tab", targetId]);
        yield* session
          .exec(["stream", "disable"])
          .pipe(Effect.catchIf(isStreamOff, () => Effect.void));
        bound.current = targetId;
      });

    const attach = Effect.gen(function* () {
      const listed = readTabs(yield* session.exec(["tab", "list"]));
      let targetId = listed[0]?.targetId;
      if (targetId === undefined) {
        const created = yield* session.exec(["tab", "new"]);
        targetId = typeof created.targetId === "string" ? created.targetId : undefined;
      }
      if (targetId === undefined) {
        return yield* new AgentBrowserError({
          command: "tab new",
          message: "the browser pane could not open a tab for this thread",
          code: null,
          data: null,
        });
      }
      yield* pin(targetId);
    });

    const gone = (error: unknown) =>
      Effect.andThen(
        Effect.sync(() => {
          bound.current = null;
        }),
        Effect.fail(
          new AgentBrowserError({
            command: "tab_gone",
            message: TAB_GONE_MESSAGE,
            code: "tab_gone",
            data: error instanceof AgentBrowserError ? error.data : null,
          }),
        ),
      );

    /** Attach when unbound; re-pin after a gap the daemon may not have survived. */
    const ensureAttached = Effect.gen(function* () {
      const at = yield* now;
      if (bound.current === null) {
        yield* attach;
      } else if (lastExecAt.current !== null && at - lastExecAt.current >= idleMs) {
        // A tab the pane closed while we were idle cannot be re-pinned.
        yield* pin(bound.current).pipe(Effect.catch((error) => gone(error)));
      }
    });

    /**
     * Follow the agent's own tab commands. A pinned session's pin moves with
     * `tab new` and `tab <id>`, and closing the bound tab leaves the session
     * pinned to nothing (recorded in `cli-tabs-pinned`), so the next call
     * attaches again rather than failing `tab_gone` for the agent's own close.
     */
    const track = (argv: ReadonlyArray<string>, data: Record<string, unknown>) =>
      Effect.sync(() => {
        if (argv[0] !== "tab" || argv[1] === "list") return;
        const targetId = typeof data.targetId === "string" ? data.targetId : null;
        if (argv[1] === "close") {
          if (targetId === null || targetId === bound.current) bound.current = null;
        } else if (targetId !== null) {
          bound.current = targetId;
        }
      });

    const exec: BrowserDriver["exec"] = (argv, execOptions) =>
      ensureAttached.pipe(
        Effect.andThen(session.exec(argv, execOptions)),
        Effect.tap((data) => track(argv, data)),
        Effect.catchIf(isTabGone, (error) => gone(error)),
        Effect.ensuring(Effect.flatMap(now, (at) => Effect.sync(() => (lastExecAt.current = at)))),
      );

    // Attach now, so a thread whose pane cannot give us a tab fails the first
    // call with the reason instead of succeeding into nothing.
    yield* attach;
    yield* Effect.flatMap(now, (at) => Effect.sync(() => (lastExecAt.current = at)));

    return {
      mode: "in-app",
      exec,
      // The guest received the human's input before we did — nothing to forward.
      sendInput: () => Effect.void,
      location: locationOf(exec),
      // In CDP mode `close` stops the daemon and sends no CDP (spike G), so
      // the pane's tabs survive it: they are the user's, not ours. A daemon
      // that will not answer `close` is killed.
      close: session.shutdown,
    } satisfies BrowserDriver;
  });

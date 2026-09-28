/**
 * The in-app driver against replays of the real agent-browser 0.38.1 driving
 * real pane webviews through the real bridge
 * (`packages/testkit/fixtures/agent-browser/cli-*`). Each test drives the
 * driver the way the service does; the replay fails it the moment the driver
 * sends a command the recording did not run next.
 *
 * - attach is `tab list`, `--pin-tab tab <first>`, `stream disable`;
 * - a daemon that stopped while idle is re-pinned (and its stream kept off)
 *   before the next command;
 * - on a thread with no tab, connecting creates one and that is what is pinned;
 * - the pane closing the pinned tab reaches the agent as `tab_gone` once, and
 *   the next call attaches to the pane's current tab — never a retry of the
 *   failed call on another tab;
 * - the pane closing every tab gets a `tab new`;
 * - the agent's own `tab new`/`tab <id>`/`tab close` keep the binding right;
 * - `close` is the CLI's `close`, and the pane's tabs survive it.
 */

import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeAgentBrowser, IDLE_TIMEOUT_MS } from "./agentBrowser";
import { openInAppDriver, REPIN_AFTER_IDLE_MS, TAB_GONE_MESSAGE } from "./inAppDriver";
import { replayCli } from "./test/replayCli";

const commandsOf = (replay: ReturnType<typeof replayCli>) =>
  replay.runs.map((run) => run.args.slice(3).join(" "));

describe("openInAppDriver (replayed)", () => {
  it.effect("attaches by listing, pinning the first tab and turning the stream off", () =>
    Effect.gen(function* () {
      const replay = replayCli("cli-attach");
      // A fresh daemon streams frames on a loopback port of its own.
      const before = yield* replay.session.exec(["stream", "status"]);
      expect(before.enabled).toBe(true);

      const driver = yield* openInAppDriver(replay.session);
      expect(driver.mode).toBe("in-app");
      expect(commandsOf(replay).slice(1)).toEqual([
        "tab list",
        `--pin-tab tab ${replay.tabs[0]!.targetId}`,
        "stream disable",
      ]);

      const after = yield* replay.session.exec(["stream", "status"]);
      expect(after.enabled).toBe(false);

      const title = yield* driver.exec(["get", "title"]);
      expect(title.title).toBe("Recording home");

      // The daemon goes away (its idle reap, here a `close`) — and with it
      // the pin. After a gap that long the driver pins again before the next
      // command, and turns the stream off again — already a little before the
      // daemon's own timeout, since the driver's clock starts late.
      yield* replay.session.exec(["close"]);
      expect(REPIN_AFTER_IDLE_MS).toBeLessThan(IDLE_TIMEOUT_MS);
      yield* TestClock.adjust(Duration.millis(REPIN_AFTER_IDLE_MS));
      const again = yield* driver.exec(["get", "title"]);
      expect(again.title).toBe("Recording home");

      yield* driver.close;
      // `close` in CDP mode sends no CDP: both of the pane's tabs are still there.
      const listed = yield* replay.session.exec(["tab", "list"]);
      expect((listed.tabs as ReadonlyArray<unknown>).length).toBe(2);
      expect(replay.remaining()).toEqual([]);
    }),
  );

  it.effect("the first call on an empty thread creates the tab it then pins", () =>
    Effect.gen(function* () {
      const replay = replayCli("cli-empty-thread");
      const driver = yield* openInAppDriver(replay.session);
      const url = yield* driver.exec(["get", "url"]);
      expect(url.url).toBe("about:blank");
      yield* driver.close;
      expect(replay.remaining()).toEqual([]);
    }),
  );

  it.effect("a tab the pane closed reaches the agent once, then the next tab is pinned", () =>
    Effect.gen(function* () {
      const replay = replayCli("cli-tab-gone");
      const driver = yield* openInAppDriver(replay.session);
      expect((yield* driver.exec(["get", "title"])).title).toBe("Recording home");

      // The pane closes the pinned tab (`{host: "remove"}` in the recording).
      const failed = yield* driver.exec(["get", "title"]).pipe(Effect.flip);
      expect(failed._tag).toBe("AgentBrowserError");
      expect(failed.message).toBe(TAB_GONE_MESSAGE);
      expect(failed._tag === "AgentBrowserError" ? failed.code : null).toBe("tab_gone");
      // The daemon's own `{targetId, lastUrl}` rides along.
      expect(failed._tag === "AgentBrowserError" ? failed.data : null).toMatchObject({
        lastUrl: "http://127.0.0.1:<SITE_PORT>/",
      });

      // The failed call was not retried: the next command the driver sent is
      // the next call's attach, and that lands on the tab that is left.
      const next = yield* driver.exec(["get", "title"]);
      expect(next.title).toBe("Second page");
      yield* driver.close;
      expect(replay.remaining()).toEqual([]);
      expect(commandsOf(replay).filter((command) => command === "get title")).toHaveLength(3);
    }),
  );

  it.effect("a pane with no tab left gets a new one on the next call", () =>
    Effect.gen(function* () {
      const replay = replayCli("cli-last-tab-gone");
      const driver = yield* openInAppDriver(replay.session);
      const failed = yield* driver.exec(["get", "title"]).pipe(Effect.flip);
      expect(failed.message).toBe(TAB_GONE_MESSAGE);
      const url = yield* driver.exec(["get", "url"]);
      expect(url.url).toBe("about:blank");
      yield* driver.close;
      expect(replay.remaining()).toEqual([]);
    }),
  );

  it.effect("follows the agent's own tab commands, including closing its tab", () =>
    Effect.gen(function* () {
      const replay = replayCli("cli-tabs-pinned");
      const driver = yield* openInAppDriver(replay.session);
      yield* driver.exec(["tab", "new", "http://127.0.0.1:<SITE_PORT>/page2"]);
      expect((yield* driver.exec(["get", "title"])).title).toBe("Second page");
      yield* driver.exec(["tab", "t1"]);
      expect((yield* driver.exec(["get", "title"])).title).toBe("Recording home");
      yield* driver.exec(["tab", "t2"]);
      yield* driver.exec(["tab", "close"]);
      // Closing the bound tab is the agent's own doing, not a `tab_gone`: the
      // next call attaches to what is left before it runs.
      expect((yield* driver.exec(["get", "title"])).title).toBe("Recording home");
      yield* driver.close;
      expect(replay.remaining()).toEqual([]);
    }),
  );

  it.effect("puts the bridge URL in the child's env and never in its argv", () =>
    Effect.gen(function* () {
      const replay = replayCli("cli-empty-thread");
      yield* openInAppDriver(replay.session);
      for (const run of replay.runs) {
        expect(run.args.join(" ")).not.toContain("--cdp");
        expect(run.args.join(" ")).not.toContain("ws://");
        expect(run.env.AGENT_BROWSER_CDP).toMatch(
          new RegExp(`^ws://127\\.0\\.0\\.1:47000/cdp/${replay.threadId}/[0-9a-f]{64}$`),
        );
      }
    }),
  );

  it.effect("reports the install prompt when the binary is missing", () =>
    Effect.gen(function* () {
      const missing = makeAgentBrowser({ binary: null, version: null, bridge: null });
      const failed = yield* openInAppDriver(missing.session("thread-1")).pipe(Effect.flip);
      expect(failed._tag).toBe("AgentBrowserUnavailable");
    }),
  );
});

import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import {
  makeCheckpointId,
  makeItemId,
  makeProjectId,
  makeThreadId,
  makeTurnId,
} from "@poseidon/contracts/ids";
import { uuidV7Millis } from "@poseidon/shared/ids";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AssistantMessageRow, UserMessageRow } from "@/components/timeline/message-rows";
import { type TimelineThread, TimelineThreadProvider } from "@/components/timeline/thread-context";
import { ClientRuntimeProvider } from "@/lib/client-runtime";
import { makeFixtureClient } from "@/lib/fixture-client";
import { formatClock, formatDurationMs, formatFullDate } from "@/lib/format";

const row = (fields: Partial<ItemSnapshot>): ItemSnapshot => ({
  itemId: makeItemId(),
  kind: "user_message",
  status: "completed",
  text: "Add a health check endpoint.",
  ...fields,
});

const render = (fields: Partial<ItemSnapshot>) =>
  renderToStaticMarkup(<UserMessageRow item={row(fields)} />);

/** The bubble alone, without the footer under it. */
const bubble = (markup: string) =>
  markup.slice(0, markup.indexOf('<div data-slot="message-footer"'));

describe("UserMessageRow", () => {
  it("renders a row without references as its text alone", () => {
    const itemId = makeItemId();
    const markup = bubble(render({ itemId }));
    // The bubble holds one markdown body with one paragraph, and nothing else.
    expect(markup).toMatch(
      /aria-label="User message"[^>]*><div [^>]*><div class="[^"]*"><p [^>]*>Add a health check endpoint\.<\/p><\/div><\/div><\/div>$/,
    );
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("Show more");
    // An empty list is the same as none: no chip row is drawn for it.
    expect(bubble(render({ itemId, references: [] }))).toBe(markup);
  });

  it("draws one chip per skill and plugin above the text", () => {
    const markup = bubble(
      render({
        references: [
          { kind: "skill", name: "health-checks" },
          { kind: "plugin", name: "formatter" },
        ],
      }),
    );
    expect(markup).toContain('aria-label="References"');
    expect(markup.match(/role="listitem"/g)).toHaveLength(2);
    expect(markup).toContain('title="Skill health-checks"');
    expect(markup).toContain('title="Plugin formatter"');
    expect(markup.match(/<svg/g)).toHaveLength(2);
    expect(markup.indexOf("formatter")).toBeLessThan(markup.indexOf("Add a health check"));
  });

  it("renders the text as markdown", () => {
    const markup = render({ text: "Please:\n\n- run `npm test`\n- fix **what fails**" });
    expect(markup).toContain("<ul");
    expect(markup.match(/<li/g)).toHaveLength(2);
    expect(markup).toContain(">npm test</code>");
    expect(markup).toContain("<strong>what fails</strong>");
  });

  it("keeps a single line ending as a line break", () => {
    const markup = render({ text: "first line\nsecond line" });
    expect(markup).toMatch(/first line<br\/>\s*second line/);
  });

  it("shows raw HTML as the text it is", () => {
    const markup = render({ text: "Make it <b>bold</b>\n\n<div>a block</div>" });
    expect(markup).toContain("Make it &lt;b&gt;bold&lt;/b&gt;");
    expect(markup).toContain("&lt;div&gt;a block&lt;/div&gt;");
    expect(markup).not.toContain("<b>");
    expect(markup).not.toContain("<div>a block");
  });

  it("keeps a heading at the size of the text", () => {
    const markup = render({ text: "# Plan\n\nDo it." });
    expect(markup).toMatch(/<h1 class="[^"]*text-sm font-semibold[^"]*">Plan<\/h1>/);
  });

  it("clamps a long message with a fade and a Show more button", () => {
    const text = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n");
    const markup = render({ text });
    expect(markup).toContain("mask-b-from-60%");
    expect(markup).toContain("max-h-[10lh]");
    // Clipped rather than hidden, so focus inside cannot scroll the text under the fade.
    expect(markup).toContain("overflow-clip");
    expect(markup).not.toContain("overflow-hidden");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Show more");
    // The whole text is still there, clamped rather than cut.
    expect(markup).toContain("line 14");
  });

  it("puts the references before a long message's text", () => {
    const markup = render({
      text: "x".repeat(700),
      references: [{ kind: "skill", name: "health-checks" }],
    });
    expect(markup).toContain("Show more");
    expect(markup.indexOf("health-checks")).toBeLessThan(markup.indexOf("xxxx"));
  });
});

describe("the user message footer", () => {
  const [t1, t2] = [makeTurnId(), makeTurnId()];
  const checkpoint = {
    checkpointId: makeCheckpointId(),
    turnId: t1,
    ref: `refs/poseidon/checkpoints/t/${t1}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const thread = (fields: Partial<TimelineThread> = {}): TimelineThread => ({
    threadId: makeThreadId(),
    projectId: makeProjectId(),
    checkpoints: [checkpoint],
    restores: [],
    restoreBlockedReason: null,
    turnOrder: [t1, t2],
    workspaceRevision: "0",
    ...fields,
  });
  // Inside a timeline the bubble's markdown reads the file atoms, so a client
  // runtime has to be in context; the fixture's answers without a server.
  const inThread = (value: TimelineThread, fields: Partial<ItemSnapshot>, steered = false) =>
    renderToStaticMarkup(
      <ClientRuntimeProvider layer={makeFixtureClient().layer}>
        <TimelineThreadProvider value={value}>
          <UserMessageRow item={row(fields)} steered={steered} />
        </TimelineThreadProvider>
      </ClientRuntimeProvider>,
    );
  const footer = (markup: string) => markup.slice(markup.indexOf('data-slot="message-footer"'));
  const restoreLabel = 'aria-label="Restore the workspace to before this message"';

  it("shows the time the id records and a copy button, revealed on hover, focus and touch", () => {
    const itemId = makeItemId();
    const markup = footer(render({ itemId }));
    expect(markup).toContain(`>${formatClock(uuidV7Millis(itemId) ?? 0)}</time>`);
    // The full date is a focus stop away, and the time's name, not a hover only.
    const full = formatFullDate(uuidV7Millis(itemId) ?? 0);
    expect(markup).toMatch(new RegExp(`<time[^>]*tabindex="0"[^>]*aria-label="${full}"`));
    expect(markup).toContain('aria-label="Copy message"');
    expect(markup).toContain("opacity-0");
    expect(markup).toContain("group-hover/message:opacity-100");
    expect(markup).toContain("group-focus-within/message:opacity-100");
    expect(markup).toContain("pointer-coarse:opacity-100");
  });

  it("has no restore outside a timeline", () => {
    expect(render({ turnId: t2 })).not.toContain(restoreLabel);
  });

  it("offers a restore to the checkpoint before the message's turn", () => {
    const markup = footer(inThread(thread(), { turnId: t2 }));
    expect(markup).toContain(restoreLabel);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*Restore the workspace/);
    expect(markup).not.toMatch(/<button[^>]*aria-disabled="true"[^>]*Restore the workspace/);
    expect(markup).not.toContain("aria-describedby");
  });

  it("names the turn a steered message joined as what its restore goes back before", () => {
    const markup = footer(inThread(thread(), { turnId: t2 }, true));
    expect(markup).not.toContain(restoreLabel);
    expect(markup).toContain(
      'aria-label="Restore the workspace to before the turn this message joined"',
    );
  });

  it("hides the restore on the first turn and when no checkpoint precedes it", () => {
    expect(inThread(thread(), { turnId: t1 })).not.toContain(restoreLabel);
    expect(inThread(thread({ checkpoints: [] }), { turnId: t2 })).not.toContain(restoreLabel);
  });

  it("disables the restore while one cannot start, keeping it focusable with its reason", () => {
    const markup = footer(
      inThread(thread({ restoreBlockedReason: "A turn is running" }), { turnId: t2 }),
    );
    const button = /<button[^>]*Restore the workspace[^>]*>/.exec(markup)?.[0] ?? "";
    expect(button).toContain('aria-disabled="true"');
    // Not the native attribute, which would drop it from the tab order.
    expect(button).not.toMatch(/\sdisabled=""/);
    const describedBy = /aria-describedby="([^"]+)"/.exec(button)?.[1];
    expect(describedBy).toBeDefined();
    expect(markup).toContain(`id="${describedBy}" class="sr-only">A turn is running</span>`);
  });
});

describe("the user message footer's fork", () => {
  const [t1, t2] = [makeTurnId(), makeTurnId()];
  const thread = (fields: Partial<TimelineThread> = {}): TimelineThread => ({
    threadId: makeThreadId(),
    projectId: makeProjectId(),
    checkpoints: [],
    restores: [],
    restoreBlockedReason: null,
    turnOrder: [t1, t2],
    workspaceRevision: "0",
    ...fields,
  });
  const inThread = (value: TimelineThread, turnId = t1) =>
    renderToStaticMarkup(
      <ClientRuntimeProvider layer={makeFixtureClient().layer}>
        <TimelineThreadProvider value={value}>
          <UserMessageRow item={row({ turnId })} />
        </TimelineThreadProvider>
      </ClientRuntimeProvider>,
    );
  const forkButton = (markup: string) =>
    /<button[^>]*aria-label="Fork from this message"[^>]*>/.exec(markup)?.[0];

  it("is left out outside a timeline", () => {
    expect(forkButton(render({ turnId: t1 }))).toBeUndefined();
  });

  it("is offered on a settled message, even while a later turn runs", () => {
    const button = forkButton(inThread(thread({ runningTurnId: t2 })));
    expect(button).toBeDefined();
    expect(button).not.toContain('aria-disabled="true"');
  });

  it("waits for the message's own turn to finish, and for the server, saying why", () => {
    const running = inThread(thread({ runningTurnId: t1 }));
    expect(forkButton(running)).toContain('aria-disabled="true"');
    expect(running).toContain("This turn is still running");
    const offline = inThread(thread({ connected: false }));
    expect(forkButton(offline)).toContain('aria-disabled="true"');
    expect(offline).toContain('class="sr-only">Not connected to the server.</span>');
  });
});

describe("AssistantMessageRow", () => {
  const answer = (fields: Partial<ItemSnapshot>): ItemSnapshot =>
    row({
      kind: "assistant_message",
      text: "Added **the endpoint**.\n\nIt answers 200.",
      ...fields,
    });
  const FADE = "motion-safe:*:starting:opacity-0";

  it("streams in the body colour, fading in what is new", () => {
    const markup = renderToStaticMarkup(
      <AssistantMessageRow item={answer({ status: "in_progress" })} />,
    );
    expect(markup).not.toContain("text-muted-foreground");
    expect(markup).toContain("text-foreground");
    expect(markup).toContain(FADE);
    expect(markup).toContain("motion-safe:*:transition-opacity");
  });

  it("stops fading once the message has settled", () => {
    const markup = renderToStaticMarkup(<AssistantMessageRow item={answer({})} />);
    expect(markup).not.toContain(FADE);
    expect(markup).toContain("<strong>the endpoint</strong>");
    expect(markup).toContain("It answers 200.");
  });

  it("has no footer unless it ends a settled turn", () => {
    const markup = renderToStaticMarkup(<AssistantMessageRow item={answer({})} />);
    expect(markup).not.toContain('data-slot="message-footer"');
  });

  it("puts copy, the time and the turn's duration under a final answer", () => {
    const itemId = makeItemId();
    const markup = renderToStaticMarkup(
      <AssistantMessageRow
        item={answer({ itemId })}
        turnEnd={{ turnId: makeTurnId(), durationMs: 123_000 }}
      />,
    );
    const footer = markup.slice(markup.indexOf('data-slot="message-footer"'));
    expect(footer).toContain("justify-start");
    expect(footer).toContain('aria-label="Copy answer"');
    expect(footer).toContain(`>${formatClock(uuidV7Millis(itemId) ?? 0)}</time>`);
    expect(footer).toContain(`>${formatDurationMs(123_000)}</span>`);
    expect(formatDurationMs(123_000)).toBe("2m 3s");
    // The tooltips' words reach the keyboard and a screen reader too.
    expect(footer).toMatch(/<time[^>]*tabindex="0"[^>]*aria-label="[^"]+"/);
    expect(footer).toMatch(/<span[^>]*tabindex="0"[^>]*aria-label="The turn took 2m 3s"/);
    expect(footer).toContain("group-hover/message:opacity-100");
    expect(footer).not.toContain("Restore");
  });

  it("leaves out a duration the ids could not measure", () => {
    const markup = renderToStaticMarkup(
      <AssistantMessageRow
        item={answer({})}
        turnEnd={{ turnId: undefined, durationMs: undefined }}
      />,
    );
    expect(markup).toContain('aria-label="Copy answer"');
    expect(markup).not.toMatch(/tabular-nums">[^<]*s<\/span>/);
  });
});

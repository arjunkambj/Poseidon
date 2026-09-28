import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { makeItemId } from "@poseidon/contracts/ids";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AssistantMessageRow, UserMessageRow } from "@/components/timeline/message-rows";
import { ErrorRow, SkillRow } from "@/components/timeline/status-rows";
import { TaskRow } from "@/components/timeline/task-row";
import {
  type FindHighlight,
  FindRowMark,
  FindText,
  ThreadFindHighlightProvider,
} from "@/components/timeline/thread-find-context";

// A task's children render through the whole row tree; only its title matters here.
vi.mock("@/components/timeline/timeline-item", () => ({ TimelineItemView: () => null }));

const item = (fields: Partial<ItemSnapshot>): ItemSnapshot => ({
  itemId: makeItemId(),
  kind: "user_message",
  status: "completed",
  text: "Deploy the service.",
  ...fields,
});

const highlight = (query: string, activeRowId?: string): FindHighlight => ({
  query,
  activeItemId: undefined,
  activeRowId,
});

const render = (node: React.ReactNode, value: FindHighlight | null) =>
  renderToStaticMarkup(
    <ThreadFindHighlightProvider value={value}>{node}</ThreadFindHighlightProvider>,
  );

const MARK = '<mark class="rounded-sm bg-primary/15 text-foreground">';

describe("find marks", () => {
  it("marks the query in plain text, ignoring case", () => {
    expect(render(<FindText text="Deploy, then deploy." />, highlight("DEPLOY"))).toBe(
      `${MARK}Deploy</mark>, then ${MARK}deploy</mark>.`,
    );
  });

  it("leaves plain text as it is while the bar is closed", () => {
    expect(render(<FindText text="Deploy." />, null)).toBe("Deploy.");
    expect(renderToStaticMarkup(<FindText text="Deploy." />)).toBe("Deploy.");
  });

  it("marks an assistant message's markdown, fenced code aside", () => {
    const answer = item({
      kind: "assistant_message",
      text: "We **deploy** on push.\n\n```sh\npnpm deploy\n```",
    });
    const markup = render(<AssistantMessageRow item={answer} />, highlight("deploy"));
    expect(markup).toContain(`<strong>${MARK}deploy</mark></strong>`);
    expect(markup.match(/<mark/g)).toHaveLength(1);
    expect(render(<AssistantMessageRow item={answer} />, null)).not.toContain("<mark");
  });

  it("marks a user message", () => {
    const markup = render(<UserMessageRow item={item({})} />, highlight("service"));
    expect(markup).toContain(`the ${MARK}service</mark>.`);
    expect(render(<UserMessageRow item={item({})} />, null)).not.toContain("<mark");
  });

  it("marks a task's title, a skill and an error", () => {
    const task = item({ kind: "task", text: "Explore the service" });
    const taskRow = <TaskRow item={task} children={[]} childrenByParent={new Map()} />;
    expect(render(taskRow, highlight("service"))).toContain(`${MARK}service</mark>`);
    const skill = item({ kind: "skill", text: "service-skill" });
    expect(render(<SkillRow item={skill} />, highlight("service"))).toContain(
      `${MARK}service</mark>-skill`,
    );
    const error = item({ kind: "error", error: { message: "The service crashed" } });
    expect(render(<ErrorRow item={error} />, highlight("service"))).toContain(
      `The ${MARK}service</mark> crashed`,
    );
  });

  it("rings the current row only, keeping the same wrapper on every row", () => {
    const row = <FindRowMark rowId="row-1">body</FindRowMark>;
    expect(render(row, highlight("x", "row-1"))).toBe(
      '<div data-find-current="true" class="rounded-lg ring-1 ring-ring ring-offset-4 ring-offset-background">body</div>',
    );
    expect(render(row, highlight("x", "row-2"))).toBe("<div>body</div>");
    expect(render(row, null)).toBe("<div>body</div>");
  });
});

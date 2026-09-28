import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { makeItemId } from "@poseidon/contracts/ids";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AssistantMessageRow, UserMessageRow } from "@/components/timeline/message-rows";
import {
  type FindHighlight,
  FindRowMark,
  FindText,
  ThreadFindHighlightProvider,
} from "@/components/timeline/thread-find-context";

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

  it("rings the current row only, keeping the same wrapper on every row", () => {
    const row = <FindRowMark rowId="row-1">body</FindRowMark>;
    expect(render(row, highlight("x", "row-1"))).toBe(
      '<div data-find-current="true" class="rounded-lg ring-1 ring-ring ring-offset-4 ring-offset-background">body</div>',
    );
    expect(render(row, highlight("x", "row-2"))).toBe("<div>body</div>");
    expect(render(row, null)).toBe("<div>body</div>");
  });
});

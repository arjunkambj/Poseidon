import fixture from "@poseidon/contracts/fixtures/thread-detail-snapshot.json";
import { makeItemId } from "@poseidon/contracts/ids";
import { ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentsPane } from "./agents-pane";

const turnId = "0199c0de-0004-7000-8000-000000000001";

const snapshot = (items: ReadonlyArray<unknown>, running: boolean): ThreadDetailSnapshot =>
  Schema.decodeUnknownSync(ThreadDetailSnapshot)({
    ...fixture,
    items,
    status: running ? "running" : "idle",
    currentTurnId: running ? turnId : null,
  });

const task = (text: string, status: ItemSnapshot["status"]) => ({
  itemId: makeItemId(),
  kind: "task",
  status,
  text,
  tool: { name: "Task", input: { prompt: `Prompt for ${text}` } },
});

/** The section headings' text, in order: "Working 1", "Done 2"… */
const headings = (html: string) =>
  [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((match) =>
    (match[1] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

/** The markup of the section whose heading starts with `title`. */
const section = (html: string, title: string) =>
  [...html.matchAll(/<section[\s\S]*?<\/section>/g)]
    .map((match) => match[0])
    .find((markup) => new RegExp(`<h3[^>]*>${title}`).test(markup)) ?? "";

describe("AgentsPane", () => {
  it("groups the thread's subagents with a count on each group", () => {
    const html = renderToStaticMarkup(
      <AgentsPane
        snapshot={snapshot(
          [
            task("Read the router", "completed"),
            task("Write the tests", "in_progress"),
            task("Check the docs", "completed"),
            task("Lint the tree", "failed"),
          ],
          true,
        )}
      />,
    );
    expect(headings(html)).toEqual(["Working 1", "Done 2", "Failed 1"]);
    expect(section(html, "Working")).toContain("Write the tests");
    expect(section(html, "Done")).toContain("Read the router");
    expect(section(html, "Done")).toContain("Check the docs");
    expect(section(html, "Failed")).toContain("Lint the tree");
    expect(html.match(/aria-label="Show in timeline"/g)).toHaveLength(4);
  });

  it("puts a task its settled turn left running under Failed, and leaves out empty groups", () => {
    const html = renderToStaticMarkup(
      <AgentsPane snapshot={snapshot([task("Stranded", "in_progress")], false)} />,
    );
    expect(headings(html)).toEqual(["Failed 1"]);
    expect(section(html, "Failed")).toContain("Stranded");
  });

  it("keeps a task an earlier turn stranded under Failed while a newer turn runs", () => {
    const earlierTurn = "0199c0de-0004-7000-8000-000000000000";
    const html = renderToStaticMarkup(
      <AgentsPane
        snapshot={snapshot(
          [
            { ...task("Stranded", "in_progress"), turnId: earlierTurn },
            { ...task("Current", "in_progress"), turnId },
          ],
          true,
        )}
      />,
    );
    expect(headings(html)).toEqual(["Working 1", "Failed 1"]);
    expect(section(html, "Working")).toContain("Current");
    expect(section(html, "Failed")).toContain("Stranded");
  });

  it("shows the empty state when the thread has no subagents", () => {
    const html = renderToStaticMarkup(
      <AgentsPane
        snapshot={snapshot(
          [{ itemId: makeItemId(), kind: "assistant_message", status: "completed", text: "Hi" }],
          false,
        )}
      />,
    );
    expect(html).toContain('data-slot="empty"');
    expect(html).toContain("No subagents yet");
    expect(headings(html)).toEqual([]);
  });
});

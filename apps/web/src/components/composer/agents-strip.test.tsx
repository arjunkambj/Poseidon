import fixture from "@poseidon/contracts/fixtures/thread-detail-snapshot.json";
import { makeItemId } from "@poseidon/contracts/ids";
import { ThreadDetailSnapshot } from "@poseidon/contracts/orchestration";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentsStrip } from "./agents-strip";

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
});

const render = (items: ReadonlyArray<unknown>, running: boolean) => {
  const doc = snapshot(items, running);
  return renderToStaticMarkup(<AgentsStrip threadId={doc.threadId} doc={doc} />);
};

describe("AgentsStrip", () => {
  it("renders nothing while no subagent is working", () => {
    expect(render([], true)).toBe("");
    expect(render([task("Read the router", "completed")], true)).toBe("");
  });

  it("renders nothing once the turn has settled", () => {
    expect(render([task("Stranded", "in_progress")], false)).toBe("");
  });

  it("leaves out a task an earlier turn stranded once a newer turn runs", () => {
    const earlierTurn = "0199c0de-0004-7000-8000-000000000000";
    const html = render(
      [
        { ...task("Current", "in_progress"), turnId },
        { ...task("Stranded", "in_progress"), turnId: earlierTurn },
      ],
      true,
    );
    expect(html).toContain("1 agent working");
    expect(html).toContain('title="Current"');
    expect(html).not.toContain("Stranded");
    expect(render([{ ...task("Stranded", "in_progress"), turnId: earlierTurn }], true)).toBe("");
  });

  it("counts one working subagent in the singular and names it", () => {
    const html = render(
      [task("Read the router", "completed"), task("Write the tests", "in_progress")],
      true,
    );
    expect(html).toContain("1 agent working");
    expect(html).toContain('title="Write the tests"');
    expect(html).not.toContain("Read the router");
    expect(html).toMatch(/<button[^>]*>View<\/button>/);
  });

  it("counts several in the plural and names the newest", () => {
    const html = render(
      [task("Write the tests", "in_progress"), task("Check the docs", "in_progress")],
      true,
    );
    expect(html).toContain("2 agents working");
    expect(html).toContain('title="Check the docs"');
    expect(html).not.toContain("Write the tests");
  });
});

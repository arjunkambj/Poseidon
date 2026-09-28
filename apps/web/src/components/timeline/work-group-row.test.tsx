import { makeItemId } from "@poseidon/contracts/ids";
import { uuidV7Millis } from "@poseidon/shared/ids";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { workGroupRow } from "@/components/timeline/fold-rows";
import { WorkGroupRow } from "@/components/timeline/work-group-row";
import { ClientRuntimeProvider } from "@/lib/client-runtime";
import { makeFixtureClient } from "@/lib/fixture-client";

// The folded rows are not under test, and their dispatcher pulls in the diff worker.
vi.mock("@/components/timeline/timeline-item", () => ({ TimelineItemView: () => null }));

const command = (cmd: string, status: ItemSnapshot["status"] = "completed"): ItemSnapshot => ({
  itemId: makeItemId(),
  kind: "command_execution",
  status,
  command: { cmd },
});

const render = (items: ReadonlyArray<ItemSnapshot>, live: boolean, endMs?: number) =>
  renderToStaticMarkup(
    <ClientRuntimeProvider layer={makeFixtureClient().layer}>
      <WorkGroupRow group={workGroupRow(items, live, endMs)} childrenByParent={new Map()} />
    </ClientRuntimeProvider>,
  );

describe("WorkGroupRow", () => {
  it("reads a live burst as its newest step, with the step count", () => {
    const markup = render([command("pnpm install"), command("pnpm test", "in_progress")], true);
    expect(markup).toContain("Running pnpm test");
    expect(markup).toContain("2 steps");
    expect(markup).not.toContain("Ran 2 commands");
  });

  it("shows no count for a live burst of one step", () => {
    const markup = render([command("pnpm test", "in_progress")], true);
    expect(markup).toContain("Running pnpm test");
    expect(markup).not.toContain("steps");
  });

  it("reads a settled group as what the run did", () => {
    const markup = render([command("pnpm install"), command("pnpm test")], false);
    expect(markup).toContain("Ran 2 commands");
    expect(markup).not.toContain("steps");
  });

  it("reads a lone thought as timed up to the row after it", () => {
    const thought: ItemSnapshot = { itemId: makeItemId(), kind: "reasoning", status: "completed" };
    const startMs = uuidV7Millis(thought.itemId) ?? 0;
    expect(render([thought], false, startMs + 4_000)).toContain("Thought for 4s");
    expect(render([thought], false)).toContain("Thought");
    expect(render([{ ...thought, status: "in_progress" }], true)).toContain("Thinking…");
  });
});

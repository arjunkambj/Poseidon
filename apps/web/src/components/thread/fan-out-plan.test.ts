import type { ModelOption } from "@poseidon/contracts/connectors";
import type { RuntimeMode } from "@poseidon/contracts/enums";
import type { ConnectorInstanceId, ThreadId } from "@poseidon/contracts/ids";
import { BRANCH_SLUG_MAX, branchSlug } from "@poseidon/shared/branchSlug";
import { describe, expect, it } from "vitest";

import type { ModelPick } from "@/lib/model-picks";

import {
  COMPARE_MAX,
  compareRefusal,
  fanOutTitle,
  fanOutWorktreeName,
  planFanOut,
  toggleComparePick,
  type FanOutInput,
} from "./fan-out-plan";

const FIRST = "instance-1" as ConnectorInstanceId;
const SECOND = "instance-2" as ConnectorInstanceId;

const pick = (model: string, instance: ConnectorInstanceId | null = FIRST): ModelPick => ({
  connectorInstanceId: instance,
  model,
});

const option = (id: string, label: string, efforts: ModelOption["efforts"] = []): ModelOption => ({
  id,
  label,
  family: "Models",
  efforts,
});

describe("toggleComparePick", () => {
  it("adds, then removes the same pick", () => {
    const added = toggleComparePick([], pick("gpt-5"));
    expect(added).toEqual([pick("gpt-5")]);
    expect(toggleComparePick(added, pick("gpt-5"))).toEqual([]);
  });

  it("tells one model under two instances apart", () => {
    const both = toggleComparePick([pick("gpt-5")], pick("gpt-5", SECOND));
    expect(both).toEqual([pick("gpt-5"), pick("gpt-5", SECOND)]);
    expect(toggleComparePick(both, pick("gpt-5", SECOND))).toEqual([pick("gpt-5")]);
  });

  it("never adds past the cap, but still removes at it", () => {
    let picks: ReadonlyArray<ModelPick> = [];
    for (const model of ["a", "b", "c", "d", "e"]) {
      picks = toggleComparePick(picks, pick(model));
    }
    expect(picks).toHaveLength(COMPARE_MAX);
    expect(picks.map((chosen) => chosen.model)).toEqual(["a", "b", "c", "d"]);
    expect(toggleComparePick(picks, pick("b")).map((chosen) => chosen.model)).toEqual([
      "a",
      "c",
      "d",
    ]);
  });
});

describe("compareRefusal", () => {
  it("refuses a project without a repository first", () => {
    expect(compareRefusal({ worktreeAllowed: false, pickCount: 3 })).toBe(
      "Compare models needs a git repository — each model works in its own worktree",
    );
  });

  it("asks for at least two models", () => {
    expect(compareRefusal({ worktreeAllowed: true, pickCount: 0 })).toBe(
      "Pick at least two models to compare",
    );
    expect(compareRefusal({ worktreeAllowed: true, pickCount: 1 })).toBe(
      "Pick at least two models to compare",
    );
  });

  it("allows two or more models in a repository", () => {
    expect(compareRefusal({ worktreeAllowed: true, pickCount: 2 })).toBeNull();
  });
});

describe("fanOutWorktreeName", () => {
  it("joins a short task and the model", () => {
    expect(fanOutWorktreeName("Fix the login bug", "GPT-5 Turbo")).toBe(
      "fix-the-login-bug-gpt-5-turbo",
    );
  });

  it("keeps the model suffix when the task alone would fill the slug", () => {
    const task = "Refactor the authentication middleware so sessions expire correctly";
    // Slugging "<task> <model>" as free text would lose the model.
    expect(branchSlug(`${task} Opus Max 4.1`)).not.toContain("opus");
    const name = fanOutWorktreeName(`${task}\nand more detail`, "Opus Max 4.1");
    expect(name.endsWith("-opus-max-4-1")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(BRANCH_SLUG_MAX);
    expect(branchSlug(name)).toBe(name);
    expect(name).toBe("refactor-the-authentication-opus-max-4-1");
  });

  it("caps a long model label at a word boundary", () => {
    const name = fanOutWorktreeName("Add tests", "inclusionai/ling-3.0-flash-sante:free");
    expect(name).toBe("add-tests-inclusionai-ling");
    expect(branchSlug(name)).toBe(name);
  });

  it("cuts a task with no word boundary hard, and still round-trips", () => {
    const name = fanOutWorktreeName("x".repeat(80), "laguna-s-2.1-free");
    expect(name.length).toBeLessThanOrEqual(BRANCH_SLUG_MAX);
    expect(name.endsWith("-laguna-s-2-1")).toBe(true);
    expect(branchSlug(name)).toBe(name);
  });

  it("falls back to the slug fallback for text with nothing usable", () => {
    const name = fanOutWorktreeName("   \n", "日本語");
    expect(name).toBe("thread-thread");
    expect(branchSlug(name)).toBe(name);
  });

  it("round-trips branchSlug for any mix of task and model", () => {
    const tasks = ["", "Ça marche — déjà vu?", "a-".repeat(40), "one two three ".repeat(10)];
    const models = ["GPT-5", "poseidon/laguna-s-2.1-free", "meta/muse-spark-1.3-contributor", "!!"];
    for (const task of tasks) {
      for (const model of models) {
        const name = fanOutWorktreeName(task, model);
        expect(branchSlug(name)).toBe(name);
      }
    }
  });
});

describe("fanOutTitle", () => {
  it("is the first non-blank line and the model", () => {
    expect(fanOutTitle("\n  Fix the login bug  \nmore", "GPT-5")).toBe("Fix the login bug · GPT-5");
  });

  it("cuts a long first line with an ellipsis", () => {
    const title = fanOutTitle("word ".repeat(30), "GPT-5");
    expect(title.endsWith("… · GPT-5")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(60 + " · GPT-5".length);
  });

  it("names a blank task a new thread", () => {
    expect(fanOutTitle("  ", "GPT-5")).toBe("New thread · GPT-5");
  });
});

describe("planFanOut", () => {
  const ids = (): (() => ThreadId) => {
    let next = 0;
    return () => `thread-${++next}` as ThreadId;
  };

  const modes: Record<string, ReadonlyArray<RuntimeMode>> = {
    [FIRST]: ["approval-required", "full-access"],
    [SECOND]: ["approval-required"],
  };

  const input = (over: Partial<FanOutInput> = {}): FanOutInput => ({
    text: "Fix the login bug",
    picks: [
      { pick: pick("gpt-5"), option: option("gpt-5", "GPT-5", ["low", "high"]) },
      { pick: pick("laguna", SECOND), option: option("laguna", "Laguna", []) },
    ],
    base: {},
    runtimeModesFor: (instance) => (instance === null ? [] : (modes[instance] ?? [])),
    baseBranch: "main",
    mintThreadId: ids(),
    ...over,
  });

  it("plans one worktree lane per pick, in pick order", () => {
    expect(planFanOut(input())).toEqual([
      {
        threadId: "thread-1",
        title: "Fix the login bug · GPT-5",
        label: "GPT-5",
        worktree: { name: "fix-the-login-bug-gpt-5", baseBranch: "main" },
        settings: { model: "gpt-5", connectorInstanceId: FIRST },
      },
      {
        threadId: "thread-2",
        title: "Fix the login bug · Laguna",
        label: "Laguna",
        worktree: { name: "fix-the-login-bug-laguna", baseBranch: "main" },
        settings: { model: "laguna", connectorInstanceId: SECOND },
      },
    ]);
  });

  it("keeps an effort only for a model that lists it", () => {
    const lanes = planFanOut(input({ base: { effort: "high" } }));
    expect(lanes.map((lane) => lane.settings.effort)).toEqual(["high", undefined]);
    expect("effort" in lanes[1]!.settings).toBe(false);
  });

  it("keeps a runtime mode only on an instance that offers it", () => {
    const full = planFanOut(input({ base: { runtimeMode: "full-access" } }));
    expect(full.map((lane) => lane.settings.runtimeMode)).toEqual(["full-access", undefined]);
    expect("runtimeMode" in full[1]!.settings).toBe(false);
    const asking = planFanOut(input({ base: { runtimeMode: "approval-required" } }));
    expect(asking.map((lane) => lane.settings.runtimeMode)).toEqual([
      "approval-required",
      "approval-required",
    ]);
  });

  it("names a model the catalog does not list by its id, and leaves the instance to routing", () => {
    const [lane] = planFanOut(
      input({
        picks: [{ pick: pick("mystery", null), option: undefined }],
        base: { effort: "low" },
      }),
    );
    expect(lane).toMatchObject({ label: "mystery", title: "Fix the login bug · mystery" });
    expect(lane!.settings).toEqual({ model: "mystery" });
  });

  it("leaves the base branch to the server when none is chosen", () => {
    const [lane] = planFanOut(input({ baseBranch: undefined }));
    expect(lane!.worktree).toEqual({ name: "fix-the-login-bug-gpt-5" });
  });
});

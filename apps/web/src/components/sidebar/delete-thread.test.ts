import type { ThreadWorktree } from "@poseidon/contracts/git";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";

import {
  deleteThread,
  dequeueForceRemoval,
  enqueueForceRemoval,
  worktreeRemovalOf,
  worktreeRemovedMessage,
  worktreeRemovers,
  type DeleteThreadSteps,
  type WorktreeRemoval,
} from "./delete-thread";

const WORKTREE: ThreadWorktree = {
  path: "/home/me/.poseidon/worktrees/app/fix-login",
  branch: "poseidon/fix-login",
  baseBranch: "main",
};

const CONFLICT: WorktreeRemoval = {
  _tag: "conflict",
  message: "The worktree has uncommitted or untracked changes — removing it would lose that work.",
};

/**
 * Steps that log each call in order. `removals` answers the remove calls in
 * turn; `offers` the "Remove anyway" offers.
 */
const recorder = (
  over: {
    readonly accepted?: boolean;
    readonly removals?: ReadonlyArray<WorktreeRemoval>;
    readonly offers?: ReadonlyArray<boolean>;
  } = {},
) => {
  const log: Array<string> = [];
  const removals = [...(over.removals ?? [{ _tag: "removed" }])];
  const offers = [...(over.offers ?? [])];
  const steps: DeleteThreadSteps = {
    deleteThread: async () => {
      log.push("delete");
      return over.accepted ?? true;
    },
    removeWorktree: async (force) => {
      log.push(force ? "remove --force" : "remove");
      return removals.shift() ?? { _tag: "removed" };
    },
    offerForce: async (message) => {
      log.push(`offer ${message}`);
      return offers.shift() ?? false;
    },
    onRemoved: (worktree) => {
      log.push(`removed ${worktree.branch}`);
    },
    onRemoveFailed: (message) => {
      log.push(`failed ${message}`);
    },
  };
  return { log, steps };
};

describe("deleteThread", () => {
  it("only deletes a local thread", async () => {
    const { log, steps } = recorder();
    await expect(deleteThread({}, true, steps)).resolves.toBe("deleted");
    expect(log).toEqual(["delete"]);
  });

  it("leaves the worktree alone when the box is unchecked", async () => {
    const { log, steps } = recorder();
    await expect(deleteThread({ worktree: WORKTREE }, false, steps)).resolves.toBe("deleted");
    expect(log).toEqual(["delete"]);
  });

  it("removes the worktree, without force, after the delete is accepted", async () => {
    const { log, steps } = recorder();
    await expect(deleteThread({ worktree: WORKTREE }, true, steps)).resolves.toBe(
      "worktree-removed",
    );
    expect(log).toEqual(["delete", "remove", "removed poseidon/fix-login"]);
  });

  it("never removes the worktree when the delete is rejected", async () => {
    const { log, steps } = recorder({ accepted: false });
    await expect(deleteThread({ worktree: WORKTREE }, true, steps)).resolves.toBe("rejected");
    expect(log).toEqual(["delete"]);
  });

  it("does not force on a conflict unless the user confirms", async () => {
    const { log, steps } = recorder({ removals: [CONFLICT], offers: [false] });
    await expect(deleteThread({ worktree: WORKTREE }, true, steps)).resolves.toBe("worktree-kept");
    expect(log).toEqual(["delete", "remove", `offer ${CONFLICT.message}`]);
  });

  it("forces the removal only after the offer is taken and confirmed", async () => {
    let takeOffer: (taken: boolean) => void = () => {};
    const { log, steps } = recorder({ removals: [CONFLICT] });
    const pending = deleteThread({ worktree: WORKTREE }, true, {
      ...steps,
      offerForce: (message) => {
        log.push(`offer ${message}`);
        return new Promise((resolve) => {
          takeOffer = resolve;
        });
      },
    });
    // The offer is on screen and unanswered: nothing has been forced.
    await expect.poll(() => log.at(-1)).toBe(`offer ${CONFLICT.message}`);
    expect(log).not.toContain("remove --force");

    takeOffer(true);
    await expect(pending).resolves.toBe("worktree-removed");
    expect(log).toEqual([
      "delete",
      "remove",
      `offer ${CONFLICT.message}`,
      "remove --force",
      "removed poseidon/fix-login",
    ]);
  });

  it("reports a forced removal that still fails", async () => {
    const { log, steps } = recorder({
      removals: [CONFLICT, { _tag: "failed", message: "busy" }],
      offers: [true],
    });
    await expect(deleteThread({ worktree: WORKTREE }, true, steps)).resolves.toBe(
      "worktree-failed",
    );
    expect(log.slice(-2)).toEqual(["remove --force", "failed busy"]);
  });

  it("reports any other refusal without offering force", async () => {
    const { log, steps } = recorder({
      removals: [{ _tag: "failed", message: "A thread still works in this worktree." }],
    });
    await expect(deleteThread({ worktree: WORKTREE }, true, steps)).resolves.toBe(
      "worktree-failed",
    );
    expect(log).toEqual(["delete", "remove", "failed A thread still works in this worktree."]);
  });
});

describe("worktreeRemovalOf", () => {
  it("reads success, conflict and other refusals", () => {
    expect(worktreeRemovalOf(Exit.succeed({}))).toEqual({ _tag: "removed" });
    expect(
      worktreeRemovalOf(Exit.fail(new PoseidonRpcError({ code: "conflict", message: "dirty" }))),
    ).toEqual({ _tag: "conflict", message: "dirty" });
    expect(
      worktreeRemovalOf(Exit.fail(new PoseidonRpcError({ code: "invalid", message: "not one" }))),
    ).toEqual({ _tag: "failed", message: "not one" });
    expect(worktreeRemovalOf(Exit.die("boom"))).toEqual({
      _tag: "failed",
      message: "The worktree was not removed.",
    });
  });
});

describe("worktreeRemovedMessage", () => {
  it("says the branch is kept", () => {
    expect(worktreeRemovedMessage(WORKTREE)).toBe(
      "Worktree removed — branch poseidon/fix-login kept",
    );
  });
});

describe("the forced removal queue", () => {
  it("keeps a first request that a second one arrives behind, and shows them in order", () => {
    const answers: Array<string> = [];
    const first = {
      worktree: WORKTREE,
      answer: (confirmed: boolean) => answers.push(`first ${confirmed}`),
    };
    const second = {
      worktree: { ...WORKTREE, path: "/home/me/.poseidon/worktrees/app/other" },
      answer: (confirmed: boolean) => answers.push(`second ${confirmed}`),
    };

    let queue = enqueueForceRemoval(enqueueForceRemoval([], first), second);
    // The same request asked twice is still one confirmation.
    queue = enqueueForceRemoval(queue, first);
    expect(queue).toEqual([first, second]);

    // The host answers the head, then drops it; the second takes its place.
    queue[0]!.answer(true);
    queue = dequeueForceRemoval(queue, first);
    expect(queue).toEqual([second]);
    queue[0]!.answer(false);
    queue = dequeueForceRemoval(queue, second);
    expect(queue).toEqual([]);
    expect(answers).toEqual(["first true", "second false"]);
  });
});

describe("worktreeRemovers", () => {
  const thread = (threadId: string, path?: string, status = "idle") => ({
    threadId,
    status,
    worktree: path === undefined ? undefined : { path },
  });

  it("removes a worktree no other thread works in", () => {
    const a = thread("a", "/wt/one");
    expect(worktreeRemovers([a], [a, thread("b")])).toEqual(new Set(["a"]));
  });

  it("keeps a worktree another thread still works in, archived or not", () => {
    const a = thread("a", "/wt/one");
    expect(worktreeRemovers([a], [a, thread("b", "/wt/one")])).toEqual(new Set());
    expect(worktreeRemovers([a], [a, thread("b", "/wt/one", "archived")])).toEqual(new Set());
  });

  it("ignores deleted threads", () => {
    const a = thread("a", "/wt/one");
    expect(worktreeRemovers([a], [a, thread("b", "/wt/one", "deleted")])).toEqual(new Set(["a"]));
  });

  it("lets the last of several deleted together remove the worktree they share", () => {
    const a = thread("a", "/wt/one");
    const b = thread("b", "/wt/one");
    const c = thread("c", "/wt/two");
    expect(worktreeRemovers([a, b, c], [a, b, c])).toEqual(new Set(["b", "c"]));
  });
});

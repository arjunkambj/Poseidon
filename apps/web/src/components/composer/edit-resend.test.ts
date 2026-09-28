import { makeCheckpointId, makeTurnId } from "@poseidon/contracts/ids";
import type { CheckpointSummary } from "@poseidon/contracts/orchestration";
import { describe, expect, it } from "vitest";

import { editCopy, editSettle, type EditInFlight } from "@/components/composer/edit-resend";
import type { RestorePoint } from "@/components/timeline/turn-checkpoints";

const checkpoint: CheckpointSummary = {
  checkpointId: makeCheckpointId(),
  turnId: makeTurnId(),
  ref: "refs/poseidon/checkpoints/t/1",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const point: RestorePoint = { checkpoint, skipsTurns: false };

describe("editCopy", () => {
  it("says an opener goes back to before the message, and what stays", () => {
    const copy = editCopy(point, false);
    expect(copy.restores).toBe(true);
    expect(copy.summary).toBe(
      "Editing a message. Sending puts the workspace back to how it was before it (later turns' file changes are undone) and sends this as a new turn. The conversation above stays, and the agent still remembers it.",
    );
    expect(copy.skippedNote).toBeNull();
  });

  it("says a steered message goes back to before the turn it joined", () => {
    const copy = editCopy(point, true);
    expect(copy.summary).toContain("how it was before the turn it joined (later turns'");
    expect(copy.restores).toBe(true);
  });

  it("warns when the restore skips a turn with no checkpoint", () => {
    expect(editCopy({ checkpoint, skipsTurns: true }, false).skippedNote).toContain(
      "The turn right before it has no checkpoint",
    );
    expect(editCopy({ checkpoint, skipsTurns: true }, true).skippedNote).toContain(
      "The turn before the one it joined",
    );
  });

  it("with no restore point, says files stay and the text is just sent", () => {
    const copy = editCopy(null, false);
    expect(copy).toEqual({
      summary: "Editing a message. Files stay as they are; this is sent as a new turn.",
      skippedNote: null,
      restores: false,
    });
    expect(editCopy(null, true)).toEqual(copy);
  });
});

describe("editSettle", () => {
  const stale = { message: "index.lock exists" };
  const sent: EditInFlight = {
    text: "Use /livez instead.",
    restoresBefore: 2,
    failureBefore: stale,
    seenRestoring: false,
  };

  it("is landed once the snapshot's restores grew", () => {
    expect(editSettle(sent, { restoring: false, restores: 3, failure: null })).toEqual({
      kind: "landed",
    });
  });

  it("waits while the restore runs, and before it has been seen at all", () => {
    expect(editSettle(sent, { restoring: true, restores: 2, failure: null }).kind).toBe("pending");
    // The receipt can beat the work order onto the subscription.
    expect(editSettle(sent, { restoring: false, restores: 2, failure: stale }).kind).toBe(
      "pending",
    );
  });

  it("is failed when restoring cleared without a new restore", () => {
    const seen = { ...sent, seenRestoring: true };
    expect(editSettle(seen, { restoring: false, restores: 2, failure: null })).toEqual({
      kind: "failed",
      message: null,
    });
  });

  it("is failed, with git's reason, on a failure newer than the one before", () => {
    const failure = { message: "a dirty submodule" };
    expect(editSettle(sent, { restoring: false, restores: 2, failure })).toEqual({
      kind: "failed",
      message: "a dirty submodule",
    });
  });
});

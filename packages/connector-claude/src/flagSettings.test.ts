import type { ThreadSettings } from "@poseidon/contracts/orchestration";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { flagSettingsFor, switchFlags, type FlagSettings } from "./flagSettings";

const base: ThreadSettings = {
  model: "default",
  runtimeMode: "approval-required",
  interactionMode: "default",
};
const at = (patch: Partial<ThreadSettings>): ThreadSettings => ({ ...base, ...patch });

describe("flagSettingsFor", () => {
  it("is null when neither the effort nor the flag changed", () => {
    expect(flagSettingsFor(base, base)).toBeNull();
    expect(flagSettingsFor(at({ effort: "high" }), at({ effort: "high" }))).toBeNull();
    expect(flagSettingsFor(at({ ultracode: true }), at({ ultracode: true }))).toBeNull();
    // Absent and false are both off.
    expect(flagSettingsFor(base, at({ ultracode: false }))).toBeNull();
    // A model or mode change is not the flag layer's.
    expect(flagSettingsFor(base, at({ model: "opus", interactionMode: "plan" }))).toBeNull();
  });

  it("names only the effort when only the effort changed", () => {
    expect(flagSettingsFor(base, at({ effort: "low" }))).toEqual({ effortLevel: "low" });
    expect(flagSettingsFor(at({ effort: "low" }), at({ effort: "max" }))).toEqual({
      effortLevel: "max",
    });
    // A rung the CLI lacks, or none, is the model's default.
    expect(flagSettingsFor(at({ effort: "low" }), at({ effort: "ultra" }))).toEqual({
      effortLevel: null,
    });
    expect(flagSettingsFor(at({ effort: "low" }), base)).toEqual({ effortLevel: null });
  });

  it("names only the flag when only the flag went off", () => {
    expect(
      flagSettingsFor(
        at({ effort: "xhigh", ultracode: true }),
        at({ effort: "xhigh", ultracode: false }),
      ),
    ).toEqual({ ultracode: false });
    expect(flagSettingsFor(at({ ultracode: true }), base)).toEqual({ ultracode: false });
  });

  it("names xhigh beside the flag going on, whatever the effort was", () => {
    // The CLI sets the flag and keeps its effort (2.1.286), so the effort the
    // mode runs at is named, even when the thread already says xhigh.
    expect(
      flagSettingsFor(at({ effort: "xhigh" }), at({ effort: "xhigh", ultracode: true })),
    ).toEqual({ effortLevel: "xhigh", ultracode: true });
    expect(flagSettingsFor(base, at({ ultracode: true }))).toEqual({
      effortLevel: "xhigh",
      ultracode: true,
    });
  });

  it("names both when both changed", () => {
    // On, as the server patches it: xhigh beside the flag.
    expect(
      flagSettingsFor(at({ effort: "low" }), at({ effort: "xhigh", ultracode: true })),
    ).toEqual({ effortLevel: "xhigh", ultracode: true });
    // An effort pick that ends ultracode: the CLI keeps the flag on an
    // effortLevel alone, so the off travels with it.
    expect(
      flagSettingsFor(
        at({ effort: "xhigh", ultracode: true }),
        at({ effort: "low", ultracode: false }),
      ),
    ).toEqual({ effortLevel: "low", ultracode: false });
  });
});

/** An `apply` that records every call and answers `accept`. */
const recorder = (accept: boolean) => {
  const calls: Array<FlagSettings> = [];
  const apply = (flags: FlagSettings) =>
    Effect.sync(() => {
      calls.push(flags);
      return accept;
    });
  return { calls, apply };
};

describe("switchFlags", () => {
  it("makes no call when nothing the flag layer holds changed", async () => {
    const { calls, apply } = recorder(true);
    const after = at({ model: "opus" });
    const result = await Effect.runPromise(switchFlags(base, after, apply));
    expect(calls).toEqual([]);
    expect(result).toEqual({ settings: after, switched: false, ultracodeSwitched: false });
  });

  it("switches ultracode on with one call and runs at xhigh after", async () => {
    const { calls, apply } = recorder(true);
    const before = at({ effort: "low" });
    const result = await Effect.runPromise(
      switchFlags(before, at({ effort: "xhigh", ultracode: true }), apply),
    );
    expect(calls).toEqual([{ effortLevel: "xhigh", ultracode: true }]);
    expect(result.settings).toEqual(at({ effort: "xhigh", ultracode: true }));
    expect(result).toMatchObject({ switched: true, ultracodeSwitched: true });
  });

  it("runs at xhigh after the flag went on, even with no effort in the patch", async () => {
    const { calls, apply } = recorder(true);
    const result = await Effect.runPromise(switchFlags(base, at({ ultracode: true }), apply));
    expect(calls).toEqual([{ effortLevel: "xhigh", ultracode: true }]);
    expect(result.settings).toEqual(at({ effort: "xhigh", ultracode: true }));
  });

  it("switches ultracode off with the effort kept", async () => {
    const { calls, apply } = recorder(true);
    const result = await Effect.runPromise(
      switchFlags(
        at({ effort: "xhigh", ultracode: true }),
        at({ effort: "xhigh", ultracode: false }),
        apply,
      ),
    );
    expect(calls).toEqual([{ ultracode: false }]);
    expect(result.settings).toEqual(at({ effort: "xhigh", ultracode: false }));
    expect(result).toMatchObject({ switched: true, ultracodeSwitched: true });
  });

  it("switches an effort alone without naming the flag", async () => {
    const { calls, apply } = recorder(true);
    const result = await Effect.runPromise(
      switchFlags(at({ effort: "high" }), at({ effort: "low" }), apply),
    );
    expect(calls).toEqual([{ effortLevel: "low" }]);
    expect(result).toEqual({
      settings: at({ effort: "low" }),
      switched: true,
      ultracodeSwitched: false,
    });
  });

  it("keeps the effort and flag from before when the CLI refuses the call", async () => {
    const { calls, apply } = recorder(false);
    const on = await Effect.runPromise(
      switchFlags(at({ effort: "low" }), at({ effort: "xhigh", ultracode: true }), apply),
    );
    expect(on.settings).toEqual(at({ effort: "low" }));
    expect("ultracode" in on.settings).toBe(false);
    expect(on).toMatchObject({ switched: true, ultracodeSwitched: true });

    const off = await Effect.runPromise(
      switchFlags(
        at({ effort: "xhigh", ultracode: true }),
        at({ effort: "low", ultracode: false }),
        apply,
      ),
    );
    expect(off.settings).toEqual(at({ effort: "xhigh", ultracode: true }));

    const effort = await Effect.runPromise(switchFlags(base, at({ effort: "max" }), apply));
    expect(effort.settings).toEqual(base);
    expect(effort.ultracodeSwitched).toBe(false);
    // One call per switch, refused or not.
    expect(calls).toHaveLength(3);
  });

  it("keeps what else the switch changed when the CLI refuses", async () => {
    const { apply } = recorder(false);
    const result = await Effect.runPromise(
      switchFlags(base, at({ model: "opus", effort: "xhigh", ultracode: true }), apply),
    );
    expect(result.settings).toEqual(at({ model: "opus" }));
  });
});

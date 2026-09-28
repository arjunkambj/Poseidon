import { describe, expect, it, vi } from "vitest";

import type { ConnectorSummary } from "@poseidon/contracts/connectors";

import {
  GENERATION_OFFLINE,
  GENERATION_UNAVAILABLE,
  generationBlockedReason,
  makeGenerationRunner,
  noticeOnce,
  type GenerationOutcome,
} from "./generation-run";

const connector = (
  enabled: boolean,
  textGeneration: boolean | undefined,
  open = true,
): ConnectorSummary =>
  ({
    enabled,
    capabilities: open ? (textGeneration === undefined ? {} : { textGeneration }) : null,
  }) as unknown as ConnectorSummary;

describe("generationBlockedReason", () => {
  it("needs the server and an enabled connector that can write", () => {
    expect(generationBlockedReason({ connected: false, connectors: [connector(true, true)] })).toBe(
      GENERATION_OFFLINE,
    );
    expect(generationBlockedReason({ connected: true, connectors: null })).not.toBeNull();
    expect(generationBlockedReason({ connected: true, connectors: [connector(true, true)] })).toBe(
      null,
    );
  });

  it("does not count a disabled, closed or non-writing connector", () => {
    for (const only of [
      connector(false, true),
      connector(true, true, false),
      connector(true, false),
      connector(true, undefined),
    ]) {
      expect(generationBlockedReason({ connected: true, connectors: [only] })).toBe(
        GENERATION_UNAVAILABLE,
      );
    }
    expect(GENERATION_UNAVAILABLE).toContain("Settings → Connectors");
  });
});

describe("makeGenerationRunner", () => {
  it("runs one call at a time and reports running", async () => {
    const changes: Array<boolean> = [];
    const runner = makeGenerationRunner((running) => changes.push(running));
    let answer: (outcome: GenerationOutcome<string>) => void = () => {};
    const first = runner.start<string>(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    expect(runner.running()).toBe(true);
    expect(await runner.start(async () => ({ ok: true, value: "second" }))).toBeNull();
    answer({ ok: true, value: "first" });
    expect(await first).toEqual({ ok: true, value: "first" });
    expect(runner.running()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("aborts on cancel and drops the late answer", async () => {
    const runner = makeGenerationRunner(() => {});
    let signal: AbortSignal | null = null;
    let answer: (outcome: GenerationOutcome<string>) => void = () => {};
    const run = runner.start<string>((given) => {
      signal = given;
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    runner.cancel();
    expect(signal!.aborted).toBe(true);
    expect(runner.running()).toBe(false);
    answer({ ok: true, value: "late" });
    expect(await run).toBeNull();
  });

  it("turns a thrown call into a failure", async () => {
    const runner = makeGenerationRunner(() => {});
    expect(
      await runner.start(async () => {
        throw new Error("socket closed");
      }),
    ).toEqual({ ok: false, message: "socket closed" });
  });
});

describe("noticeOnce", () => {
  it("shows each notice once per session and skips none", () => {
    const show = vi.fn();
    noticeOnce(undefined, show);
    noticeOnce("Your writing model is off — used the thread's model.", show);
    noticeOnce("Your writing model is off — used the thread's model.", show);
    expect(show).toHaveBeenCalledOnce();
  });
});

/**
 * What `turn/start` names for a turn, against the model catalogue the real
 * app-server answered (`fixtures/codex/probe/`): the CLI keeps the last model
 * and effort it was sent, so a turn names each one that differs from what the
 * thread holds — never leaves out a change hoping for a default.
 */

import { loadStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import type { ThreadSettings } from "@poseidon/contracts/orchestration";

import { CODEX_KIND } from "./kind";
import { modelFactsOf } from "./models";
import { ModelListResponse } from "./protocol";
import type { OpenedThread } from "./threadOpen";
import { holdsOf, turnOverrides, turnTarget } from "./turnSettings";

const facts = (() => {
  const handshake = loadStdioJsonRpcRecording(CODEX_KIND, "probe").invocations.find((invocation) =>
    invocation.argv.includes("app-server"),
  )!;
  const listed = handshake.frames.find(
    (frame) =>
      frame.dir === "from-harness" &&
      (frame.data as { result?: { data?: unknown } }).result?.data !== undefined,
  )!.data as { result: unknown };
  return modelFactsOf(Schema.decodeUnknownSync(ModelListResponse)(listed.result).data);
})();
const factsFor = (model: string) => facts.get(model);

/** A thread the CLI opened on its default, as every recording shows it. */
const OPENED: OpenedThread = { threadId: "t", model: "gpt-6-astra", effort: "medium" };

const settings = (model: string, effort?: ThreadSettings["effort"]): ThreadSettings => ({
  model,
  runtimeMode: "approval-required",
  interactionMode: "default",
  ...(effort === undefined ? {} : { effort }),
});

describe("turnTarget", () => {
  it("runs a thread on default at the model and effort the CLI opened it with", () => {
    expect(turnTarget({ settings: settings("default"), opened: OPENED, factsFor })).toEqual({
      model: "gpt-6-astra",
      effort: "medium",
    });
  });

  it("keeps an effort the model offers", () => {
    expect(
      turnTarget({ settings: settings("gpt-6-sol", "max"), opened: OPENED, factsFor }),
    ).toEqual({ model: "gpt-6-sol", effort: "max" });
  });

  it("runs a model at its own default when it does not offer the thread's effort", () => {
    // gpt-5.5 stops at xhigh.
    expect(turnTarget({ settings: settings("gpt-5.5", "max"), opened: OPENED, factsFor })).toEqual({
      model: "gpt-5.5",
      effort: "medium",
    });
  });

  it("trusts the thread's effort when the models were never listed", () => {
    expect(turnTarget({ settings: settings("gpt-5.5", "max"), opened: OPENED })).toEqual({
      model: "gpt-5.5",
      effort: "max",
    });
    expect(turnTarget({ settings: settings("gpt-5.5"), opened: OPENED })).toEqual({
      model: "gpt-5.5",
      effort: undefined,
    });
  });
});

describe("turnOverrides", () => {
  it("names nothing for a turn on what the thread already holds", () => {
    const target = turnTarget({ settings: settings("default"), opened: OPENED, factsFor });
    expect(turnOverrides(target, holdsOf(OPENED))).toEqual({
      params: {},
      next: { model: "gpt-6-astra", effort: "medium" },
    });
  });

  it("names the new model's default effort when a switch drops the old one", () => {
    const onSol = { model: "gpt-6-sol", effort: "max" } as const;
    const target = turnTarget({ settings: settings("gpt-5.5", "max"), opened: OPENED, factsFor });
    expect(turnOverrides(target, onSol).params).toEqual({ model: "gpt-5.5", effort: "medium" });
  });

  it("names the model the CLI opened the thread on when the thread goes back to default", () => {
    const onLuna = { model: "gpt-6-luna", effort: "low" } as const;
    const target = turnTarget({ settings: settings("default"), opened: OPENED, factsFor });
    expect(turnOverrides(target, onLuna).params).toEqual({
      model: "gpt-6-astra",
      effort: "medium",
    });
  });

  it("names an effort change alone on the same model", () => {
    const target = turnTarget({ settings: settings("default", "high"), opened: OPENED, factsFor });
    expect(turnOverrides(target, holdsOf(OPENED))).toEqual({
      params: { effort: "high" },
      next: { model: "gpt-6-astra", effort: "high" },
    });
  });

  it("forgets the effort when a model is named with none", () => {
    const target = turnTarget({ settings: settings("gpt-5.5"), opened: OPENED });
    expect(turnOverrides(target, holdsOf(OPENED))).toEqual({
      params: { model: "gpt-5.5" },
      next: { model: "gpt-5.5", effort: undefined },
    });
  });
});

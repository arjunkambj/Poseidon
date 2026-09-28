import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  emptyComposerDraft,
  isEmptyDraft,
  useComposerDraft,
  useComposerDraftWriter,
  type ComposerDraft,
} from "./ui";

const render = (registry: AtomRegistry.AtomRegistry, Probe: () => null) =>
  renderToStaticMarkup(
    <RegistryContext.Provider value={registry}>
      <Probe />
    </RegistryContext.Provider>,
  );

const writerIn = (registry: AtomRegistry.AtomRegistry) => {
  let writer: ReturnType<typeof useComposerDraftWriter> | null = null;
  render(registry, () => {
    writer = useComposerDraftWriter();
    return null;
  });
  return writer!;
};

const draftIn = (registry: AtomRegistry.AtomRegistry, threadId: string): ComposerDraft => {
  let draft: ComposerDraft = emptyComposerDraft;
  render(registry, () => {
    const { text, mentions, references, files } = useComposerDraft(threadId);
    draft = { text, mentions, references, files };
    return null;
  });
  return draft;
};

describe("useComposerDraftWriter", () => {
  const snapshot: ComposerDraft = { ...emptyComposerDraft, text: "fix the login", mentions: ["a"] };

  it("writes a draft under any thread's id", () => {
    const registry = AtomRegistry.make();
    const write = writerIn(registry);
    write("parked", snapshot);
    expect(draftIn(registry, "parked")).toEqual(snapshot);
    expect(draftIn(registry, "other")).toEqual(emptyComposerDraft);
  });

  it("clears a draft, and fills one only while it is empty", () => {
    const registry = AtomRegistry.make();
    const write = writerIn(registry);
    write("start", snapshot);
    write("start", emptyComposerDraft);
    expect(draftIn(registry, "start")).toEqual(emptyComposerDraft);

    const restore = (current: ComposerDraft) => (isEmptyDraft(current) ? snapshot : current);
    write("start", restore);
    expect(draftIn(registry, "start")).toEqual(snapshot);
    write("start", { ...emptyComposerDraft, text: "the next task" });
    write("start", restore);
    expect(draftIn(registry, "start").text).toBe("the next task");
  });
});

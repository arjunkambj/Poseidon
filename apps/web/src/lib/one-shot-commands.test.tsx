import { RegistryContext } from "@effect/atom-react";
import { makeThreadId } from "@poseidon/contracts/ids";
import { AtomRegistry } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { installAppAtoms } from "@/state/app-runtime";

import { getOneShotCommands, useOneShotCommands } from "./one-shot-commands";

// Offline: nothing answers, which is fine — only the binding is under test.
installAppAtoms(null);

describe("one-shot commands", () => {
  it("are built once on the app's runtime", () => {
    expect(getOneShotCommands()).toBe(getOneShotCommands());
  });

  it("the hook binds each call to the registry in context", () => {
    const registry = AtomRegistry.make();
    const commands = getOneShotCommands();
    const stage = vi.spyOn(commands, "stageAttachment").mockResolvedValue(undefined as never);
    let bound: ReturnType<typeof useOneShotCommands> | null = null;
    const Probe = () => {
      bound = useOneShotCommands();
      return null;
    };
    renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    );

    const input = { threadId: makeThreadId(), name: "one.png", base64: "AAAA" };
    void bound!.stageAttachment(input);
    expect(stage).toHaveBeenCalledWith(registry, input);
    stage.mockRestore();
  });
});

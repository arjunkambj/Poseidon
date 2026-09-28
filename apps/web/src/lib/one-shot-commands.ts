/**
 * The one-shot thread writes (`@poseidon/client-runtime/oneShotCommands`),
 * built once on the app's runtime and bound to the registry in context.
 *
 * A start that runs in the background, or several started at once, sends
 * through these instead of `dispatchAtom` and `stageAttachmentAtom`: each call
 * resolves with its own `Exit`, and none interrupts another or the composer's
 * next send.
 */

import { RegistryContext } from "@effect/atom-react";
import {
  makeOneShotCommands,
  type OneShotCommands,
} from "@poseidon/client-runtime/oneShotCommands";
import * as React from "react";

import { getAppAtoms } from "@/state/app-runtime";

let oneShotCommands: OneShotCommands | null = null;

export const getOneShotCommands = (): OneShotCommands => {
  oneShotCommands ??= makeOneShotCommands(getAppAtoms().runtime);
  return oneShotCommands;
};

/** `dispatch` and `stageAttachment`, bound to the app's registry. */
export const useOneShotCommands = () => {
  const registry = React.useContext(RegistryContext);
  return React.useMemo(() => {
    const commands = getOneShotCommands();
    return {
      dispatch: (command: Parameters<OneShotCommands["dispatch"]>[1]) =>
        commands.dispatch(registry, command),
      stageAttachment: (input: Parameters<OneShotCommands["stageAttachment"]>[1]) =>
        commands.stageAttachment(registry, input),
    };
  }, [registry]);
};

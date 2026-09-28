/**
 * The detected-scripts atoms, built once per client runtime, the way
 * `@/components/open-in/editor-atoms` builds the editor list: the Run menu
 * shares the app's one WebSocket, and a fixture page substitutes its own
 * runtime through `ClientRuntimeProvider`.
 *
 * `useDetectedScripts` is read only by the open Run menu, so `scripts.detect`
 * runs when the menu opens and never on a header's mount.
 */

import { useAtomValue } from "@effect/atom-react";
import {
  makeScriptAtoms,
  type ScriptAtoms,
  type ScriptScope,
} from "@poseidon/client-runtime/scriptAtoms";
import type { DetectedScript } from "@poseidon/contracts/scripts";
import { AsyncResult } from "effect/unstable/reactivity";

import { type ClientRuntime, useClientRuntime } from "@/lib/client-runtime";

const byRuntime = new WeakMap<ClientRuntime["runtime"], ScriptAtoms>();

const useScriptAtoms = (): ScriptAtoms => {
  const { runtime } = useClientRuntime();
  let atoms = byRuntime.get(runtime);
  if (atoms === undefined) {
    atoms = makeScriptAtoms(runtime);
    byRuntime.set(runtime, atoms);
  }
  return atoms;
};

/** The workspace's package.json scripts, or null until the server has answered. */
export const useDetectedScripts = (scope: ScriptScope): ReadonlyArray<DetectedScript> | null => {
  const result = useAtomValue(useScriptAtoms().detectedScriptsAtom(scope));
  return AsyncResult.isSuccess(result) ? result.value : null;
};

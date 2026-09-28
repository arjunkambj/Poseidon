/**
 * The editor atoms, built once per client runtime.
 *
 * The app has one runtime (`@/state/app-runtime`), so this adds the editor
 * list and the open call on top of it the way `../panes/files/file-atoms.ts`
 * adds the file atoms: the header's "Open in" control and the file menus share
 * one WebSocket, and one listing, with the rest of the app. A fixture page
 * substitutes its own runtime through `ClientRuntimeProvider` and lists the
 * fixture's editors instead.
 *
 * The open is a one-shot call on the registry in context, resolving with its
 * own `Exit` for the caller to toast a refusal.
 */

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  makeEditorAtoms,
  type EditorAtoms,
  type OpenInInput,
} from "@poseidon/client-runtime/editors";
import type { DetectedEditor } from "@poseidon/contracts/editors";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { type ClientRuntime, useClientRuntime } from "@/lib/client-runtime";

const byRuntime = new WeakMap<ClientRuntime["runtime"], EditorAtoms>();

const useEditorAtoms = (): EditorAtoms => {
  const { runtime } = useClientRuntime();
  let atoms = byRuntime.get(runtime);
  if (atoms === undefined) {
    atoms = makeEditorAtoms(runtime);
    byRuntime.set(runtime, atoms);
  }
  return atoms;
};

const none: ReadonlyArray<DetectedEditor> = [];

/** What the server found installed; empty offline and before the first listing. */
export const useDetectedEditors = (): ReadonlyArray<DetectedEditor> => {
  const result = useAtomValue(useEditorAtoms().editorsAtom);
  return AsyncResult.isSuccess(result) ? result.value : none;
};

/** `editors.open`, bound to the registry in context. */
export const useOpenIn = () => {
  const registry = React.useContext(RegistryContext);
  const { openIn } = useEditorAtoms();
  return React.useCallback((input: OpenInInput) => openIn(registry, input), [openIn, registry]);
};

/**
 * The palette's message-search atom, built once on the app's own
 * `AtomRuntime` — the same way the folder picker adds `fsAtoms` — so the
 * search shares the app's one WebSocket.
 */

import { makeSearchAtoms, type SearchAtoms } from "@poseidon/client-runtime/searchAtoms";

import { getAppAtoms } from "@/state/app-runtime";

let searchAtoms: SearchAtoms | null = null;

export const useSearchAtoms = (): SearchAtoms => {
  searchAtoms ??= makeSearchAtoms(getAppAtoms().runtime);
  return searchAtoms;
};

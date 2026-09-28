/**
 * The atom-reading hooks every component goes through. They unwrap
 * `AsyncResult` into plain values with honest fallbacks (empty list,
 * "connecting"), and dispatch goes through `useAtomSet` in `promiseExit` mode
 * so callers see the receipt or the failure.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ConnectionState } from "@poseidon/client-runtime/connection";
import { desktopServerStateAtom } from "@poseidon/client-runtime/desktop";
import type { ThreadDetailView } from "@poseidon/client-runtime/clientState";
import type { DesktopServerState } from "@poseidon/client-runtime/resolver";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { ProjectSummary, ThreadSummary } from "@poseidon/contracts/orchestration";
import type * as PoseidonRpcError from "@poseidon/contracts/rpc";
import type * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Atom from "effect/unstable/reactivity/Atom";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";

import { getAppAtoms } from "./app-runtime";

const CONNECTING: ConnectionState = { status: "connecting", serverInstanceId: null };

/** `connectionStateAtom` — drives the reconnecting/offline banner. */
export const useConnectionState = (): ConnectionState =>
  AsyncResult.getOrElse(useAtomValue(getAppAtoms().connectionStateAtom), () => CONNECTING);

/**
 * What the desktop supervisor is doing with the server *process* — starting
 * it, restarting it, or giving up. `null` in a plain browser tab, where the
 * socket state is the whole story.
 */
export const useDesktopServerState = (): DesktopServerState | null =>
  useAtomValue(desktopServerStateAtom);

/** `projectsAtom` — the sidebar's project list. Empty until connected. */
export const useProjects = (): ReadonlyArray<ProjectSummary> =>
  AsyncResult.getOrElse(useAtomValue(getAppAtoms().projectsAtom), () => []);

/**
 * The same list, but `null` until the server has answered — for a decision an
 * empty list while loading would get wrong, like opening first-run setup.
 */
export const useLoadedProjects = (): ReadonlyArray<ProjectSummary> | null =>
  AsyncResult.getOrElse(useAtomValue(getAppAtoms().projectsAtom), () => null);

/**
 * `threadListAtom(null)` — every thread, grouped by project in the sidebar.
 * Empty until connected.
 */
export const useThreadList = (): ReadonlyArray<ThreadSummary> =>
  AsyncResult.getOrElse(useAtomValue(getAppAtoms().threadListAtom(null)), () => []);

/**
 * The same list, but `null` until the server has sent its first snapshot — for
 * a page whose empty state would otherwise claim there are no threads while
 * it is still loading, or while no server is reachable.
 */
export const useLoadedThreadList = (): ReadonlyArray<ThreadSummary> | null =>
  AsyncResult.getOrElse(useAtomValue(getAppAtoms().threadListAtom(null)), () => null);

type ThreadDetailResult = AsyncResult.AsyncResult<
  ThreadDetailView,
  PoseidonRpcError.PoseidonRpcError | RpcClientError.RpcClientError | Cause.NoSuchElementError
>;

const emptyDetailAtom = Atom.make<ThreadDetailResult>(AsyncResult.initial());

/**
 * `threadDetailAtom(threadId)` — the live snapshot for the thread view. A
 * `null` threadId reads a permanently-initial atom instead, so callers never
 * subscribe to a thread that is not in the URL.
 */
export const useThreadDetail = (threadId: ThreadId | null): ThreadDetailResult => {
  const atoms = getAppAtoms();
  return useAtomValue(threadId === null ? emptyDetailAtom : atoms.threadDetailAtom(threadId));
};

/**
 * `dispatchAtom` — resolves with the command's `Exit`: success carries the
 * `CommandReceipt`, failure carries the RPC error. Never throws.
 */
export const useDispatchCommand = () =>
  useAtomSet(getAppAtoms().dispatchAtom, { mode: "promiseExit" });

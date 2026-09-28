/**
 * Wipes a deleted thread's browsing data: the cookies, storage and cache of
 * its `persist:thread-<id>` partition, after cutting the thread's
 * browser-bridge connections.
 *
 * The window asks, once the thread has left its list and its pane tabs are
 * gone (`CLEAR_THREAD_CHANNEL`, in `./tabsChannel`). The id comes from the renderer, so it
 * is checked against the same pattern the bridge accepts before it names a
 * partition — anything else could point `fromPartition` at a session that is
 * not a pane's. A thread that never had a partition on disk is left alone
 * rather than created just to be cleared.
 *
 * `makeClearAll` is the Browser settings page's "Clear browsing data": every
 * thread partition on disk, by the directory names Electron gave them, each
 * cleared the same way.
 *
 * `makeClearStale` catches what the window's live watch cannot: a thread
 * deleted while the app was closed, from another client, or during the grace
 * before the window counted it gone. Once per launch the window hands over
 * the ids of every thread that still exists, and each partition on disk whose
 * thread is not among them is cleared. Partitions live in Electron's session
 * data, which every `POSEIDON_HOME` shares, so only the default home sweeps:
 * a scratch home's server lists its own threads, and every real thread would
 * look deleted to it (`homeOwnsPartitions`).
 *
 * Electron-free: `../ipc.ts` passes in how to find and open the partition.
 */
import { BRIDGE_THREAD_ID } from "@poseidon/shared/browserBridge";
import { configDir } from "@poseidon/shared/paths";

/** The parts of an Electron `Session` clearing needs. */
export interface ClearableSession {
  readonly clearStorageData: () => Promise<void>;
  readonly clearCache: () => Promise<void>;
}

export interface ClearThreadOptions {
  /** Whether `persist:thread-<id>` has a directory on disk yet. */
  readonly partitionExists: (threadId: string) => boolean;
  /** `session.fromPartition`. */
  readonly fromPartition: (partition: string) => ClearableSession;
  /**
   * Cuts the thread's browser-bridge connections first, for a thread that was
   * deleted: nothing may go on driving it while its data goes.
   */
  readonly disconnect?: (threadId: string) => void;
}

/** Resolves `true` when a partition was cleared, `false` when there was none. */
export const makeClearThread =
  (options: ClearThreadOptions) =>
  async (threadId: unknown): Promise<boolean> => {
    if (typeof threadId !== "string" || !BRIDGE_THREAD_ID.test(threadId)) {
      throw new Error("not a thread id");
    }
    options.disconnect?.(threadId);
    if (!options.partitionExists(threadId)) return false;
    const session = options.fromPartition(`persist:thread-${threadId}`);
    await session.clearStorageData();
    await session.clearCache();
    return true;
  };

/** The thread ids whose partition directories are listed, and nothing else. */
export const threadsOnDisk = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  names.flatMap((name) => {
    if (!name.startsWith("thread-")) return [];
    const threadId = name.slice("thread-".length);
    return BRIDGE_THREAD_ID.test(threadId) ? [threadId] : [];
  });

/** Resolves how many thread partitions were cleared. */
export const makeClearAll =
  (options: ClearThreadOptions & { readonly listPartitions: () => ReadonlyArray<string> }) =>
  async (): Promise<number> => {
    const clear = makeClearThread(options);
    let cleared = 0;
    for (const threadId of threadsOnDisk(options.listPartitions())) {
      if (await clear(threadId)) cleared += 1;
    }
    return cleared;
  };

/**
 * Whether the home in `env` is the default one, whose server lists the
 * threads the partitions on disk belong to. A scratch home's partitions sit
 * beside the default home's, and the default home's sweep clears them.
 */
export const homeOwnsPartitions = (env: Readonly<Record<string, string | undefined>>): boolean =>
  configDir(env) === configDir({});

/** The most ids a stale sweep accepts; a real thread list is far shorter. */
const MAX_LIVE_THREADS = 100_000;

/**
 * Resolves how many partitions of threads outside `live` were cleared. `live`
 * comes from the renderer, so anything but a non-empty list of strings is
 * refused: an empty list is what a list still loading looks like, and must
 * never read as "every thread was deleted". A home that does not own the
 * partitions (`homeOwnsPartitions`) clears nothing.
 */
export const makeClearStale =
  (
    options: ClearThreadOptions & {
      readonly listPartitions: () => ReadonlyArray<string>;
      readonly ownsPartitions: boolean;
    },
  ) =>
  async (live: unknown): Promise<number> => {
    if (
      !Array.isArray(live) ||
      live.length === 0 ||
      live.length > MAX_LIVE_THREADS ||
      !live.every((threadId) => typeof threadId === "string")
    ) {
      throw new Error("not a thread list");
    }
    if (!options.ownsPartitions) return 0;
    const keep = new Set<string>(live);
    const clear = makeClearThread(options);
    let cleared = 0;
    for (const threadId of threadsOnDisk(options.listPartitions())) {
      if (!keep.has(threadId) && (await clear(threadId))) cleared += 1;
    }
    return cleared;
  };

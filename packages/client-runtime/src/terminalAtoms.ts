/**
 * The integrated terminal's half of the client runtime.
 *
 * - `terminalListAtom(ownerKey)` — `terminal.list` for one owner, a thread, a
 *   project with no thread yet or home, keyed by `terminalOwnerKey` (a
 *   thread's key is its bare id). Refetched on every connected epoch and after
 *   `openTerminal` / `closeTerminal`. A failure is a value
 *   (`TerminalListQuery`), not the atom's error channel, so the drawer can say
 *   what went wrong and the next reconnect still has a stream to refetch on.
 * - `runningTerminalsAtom` — `terminal.listRunning`: every thread's terminals
 *   still running a shell, one listing for the whole sidebar rather than one
 *   per thread row. Refetched like the owner lists, and after every open,
 *   close and hand-over whatever the owner.
 * - `openTerminal` — `terminal.open`, a one-shot call (`./oneShot`) on the
 *   caller's registry that resolves with its own `Exit`.
 * - `writeTerminal`, `resizeTerminal`, `closeTerminal` — the other three
 *   calls, as `runtime.fn`s.
 * - `listTerminals` — one `terminal.list`, answered once.
 * - `adoptTerminals` — `terminal.adopt`, the hand-over of a project's
 *   terminals to the local thread the New task page just started; both
 *   owners' lists are refetched after it.
 * - `terminalAttachAtom(key)` — the output of one terminal, handed to a
 *   callback item by item.
 *
 * Output is deliberately **not** an atom over the subscribe stream. An atom
 * built from a stream keeps only the last element of each chunk the stream
 * emits, which for a terminal would silently drop bytes whenever the socket
 * delivers two items at once. The attach atom is a `runtime.fn` instead: the
 * renderer sets it with a callback on mount and resets it on unmount, which
 * interrupts the run, and every item reaches the callback, in order.
 *
 * The write, resize and close fns are `concurrent`. A plain `runtime.fn`
 * interrupts its previous run when it is set again, which would drop keystrokes
 * typed while an earlier one was in flight. Input goes through one lane per
 * terminal instead (`makeInputLanes`), so it reaches the shell in the order it
 * was typed however the calls are scheduled.
 *
 * A concurrent fn's answer is not its call's, though: it answers with the
 * first of the runs still in flight when its own is joined — another call's
 * answer when two overlap, and none at all when its own finished before the
 * join. That is fine for the three calls nobody reads the answer of. The drawer
 * reads the summary `openTerminal` answers with, so that one is a one-shot: two
 * tabs opening together each get their own terminal. `adoptTerminals` and
 * `listTerminals` are plain fns, because their callers read the answer too; the
 * New task hand-over makes one of each at a time.
 *
 * Like the other atom modules, this takes the `AtomRuntime` that `makeRuntime`
 * already built, so the terminal shares one connection with everything else.
 */

import type { ProjectId, TerminalId, ThreadId } from "@poseidon/contracts/ids";
import type { PoseidonRpcError } from "@poseidon/contracts/rpc";
import {
  TERMINAL_WRITE_MAX_CHARS,
  decodeTerminalOwnerKey,
  terminalOwnerKey,
  terminalOwnerOf,
  type TerminalOwner,
  type TerminalScriptLaunch,
  type TerminalSize,
  type TerminalStreamItem,
  type TerminalSummary,
} from "@poseidon/contracts/terminal";
import * as Effect from "effect/Effect";
import { isTagged } from "effect/Predicate";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Atom from "effect/unstable/reactivity/Atom";
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";

import { transportOnly } from "./atoms";
import { Connection, ConnectionStateRef } from "./connection";
import { runOneShot } from "./oneShot";

/** `terminal.list` as a value: the owner's terminals, or why they could not be listed. */
export type TerminalListQuery =
  | { readonly _tag: "ok"; readonly terminals: ReadonlyArray<TerminalSummary> }
  | { readonly _tag: "error"; readonly message: string };

/** One terminal, as every call after `open` names it: its owner, and its own id. */
export type TerminalRef = TerminalOwner & { readonly terminalId: TerminalId };

export type TerminalOpenArgs = TerminalRef &
  TerminalSize & {
    readonly title?: string | undefined;
    /** Runs this script as the terminal's own process instead of an interactive shell. */
    readonly script?: TerminalScriptLaunch | undefined;
  };

/** The ref alone, without whatever else the call carries. */
const refOf = (args: TerminalRef): TerminalRef => ({
  ...terminalOwnerOf(args),
  terminalId: args.terminalId,
});

/**
 * What the attach callback receives: every stream item as the server sent it,
 * plus `gone` when the server no longer knows the terminal — after a server
 * restart, say, since scrollback lives only in memory. `gone` is the last call.
 */
export type TerminalAttachItem = TerminalStreamItem | { readonly kind: "gone" };

/**
 * `Atom.family` keys have to be primitives, so a terminal becomes one string:
 * its owner's key, then its id. A project's key holds a separator of its own,
 * but ids are UUIDs and never do, so the last one splits them; home's key
 * holds none. A test pins the round trip.
 */
export const encodeTerminalKey = (ref: TerminalRef): string =>
  `${terminalOwnerKey(ref)}:${ref.terminalId}`;

export const decodeTerminalKey = (key: string): TerminalRef => {
  const separator = key.lastIndexOf(":");
  return {
    ...decodeTerminalOwnerKey(key.slice(0, separator)),
    terminalId: key.slice(separator + 1) as TerminalId,
  };
};

type TerminalRpcError = PoseidonRpcError | RpcClientError.RpcClientError;

const isGone = (error: TerminalRpcError): boolean =>
  isTagged(error, "PoseidonRpcError") && error.code === "not-found";

/**
 * One subscription, run to its end with every item handed to `onItem`.
 * Succeeds with whether it ended on `resnapshot-required` — the one clean end
 * that asks the client to subscribe again. After `exited` nothing can follow.
 */
const attachOnce = (
  ref: TerminalRef,
  onItem: (item: TerminalAttachItem) => void,
): Effect.Effect<boolean, TerminalRpcError, Connection> =>
  Effect.gen(function* () {
    const client = yield* (yield* Connection).client;
    let resnapshot = false;
    yield* Stream.runForEach(client["terminal.subscribe"](ref), (item) =>
      Effect.sync(() => {
        resnapshot = item.kind === "resnapshot-required";
        onItem(item);
      }),
    );
    return resnapshot;
  });

/**
 * Attach until the terminal is done with: a dropped socket retries on the
 * fresh one, a subscriber that fell behind resubscribes, and both begin again
 * with a `snapshot` the renderer resets to. A terminal the server does not know
 * is reported once as `gone` rather than retried; any other refusal from the
 * server fails the run.
 */
const attach = (
  ref: TerminalRef,
  onItem: (item: TerminalAttachItem) => void,
): Effect.Effect<void, TerminalRpcError, Connection> => {
  const loop: Effect.Effect<void, TerminalRpcError, Connection> = attachOnce(ref, onItem).pipe(
    Effect.retry(transportOnly<TerminalRpcError>()),
    Effect.flatMap((again) => (again ? Effect.suspend(() => loop) : Effect.void)),
  );
  return loop.pipe(Effect.catchIf(isGone, () => Effect.sync(() => onItem({ kind: "gone" }))));
};

/** The longest prefix of `data` that fits one write and does not split a surrogate pair. */
const nextWrite = (data: string): string => {
  if (data.length <= TERMINAL_WRITE_MAX_CHARS) return data;
  const end = TERMINAL_WRITE_MAX_CHARS;
  const high = data.charCodeAt(end - 1);
  return data.slice(0, high >= 0xd800 && high <= 0xdbff ? end - 1 : end);
};

/**
 * Input queued per terminal and sent by one sender at a time. A call appends
 * to its terminal's pending input synchronously, then whichever call holds the
 * lock sends everything pending, so keys typed while a write is in flight
 * leave together as the next write, in order. A resize keeps only the latest
 * size.
 *
 * A failed call loses what it carried, and on purpose takes with it the input
 * that was already queued behind it when it left — the rest of a paste split
 * across writes, above all — since that was meant to follow what was lost and
 * would otherwise reach the shell with the user's next key, possibly much
 * later. Input typed while the call was in flight has its own call queued and
 * is still sent. A terminal the server answers `not-found` for is gone for
 * good, so its whole lane goes.
 */
const makeInputLanes = () => {
  const lock = Semaphore.makeUnsafe(1);
  const pending = new Map<string, { data: string; size: TerminalSize | null }>();

  const laneOf = (key: string) => {
    let lane = pending.get(key);
    if (lane === undefined) {
      lane = { data: "", size: null };
      pending.set(key, lane);
    }
    return lane;
  };

  const flush = (key: string): Effect.Effect<void, TerminalRpcError, Connection> =>
    Effect.gen(function* () {
      const ref = decodeTerminalKey(key);
      const client = yield* (yield* Connection).client;
      for (let lane = pending.get(key); lane !== undefined; lane = pending.get(key)) {
        if (lane.size !== null) {
          const size = lane.size;
          lane.size = null;
          yield* client["terminal.resize"]({ ...ref, ...size });
        } else if (lane.data.length > 0) {
          const current = lane;
          const data = nextWrite(current.data);
          current.data = current.data.slice(data.length);
          const queuedBehind = current.data.length;
          yield* client["terminal.write"]({ ...ref, data }).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                current.data = current.data.slice(queuedBehind);
              }),
            ),
          );
        } else {
          pending.delete(key);
        }
      }
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          const lane = pending.get(key);
          if (lane === undefined) return;
          if (isGone(error) || (lane.data.length === 0 && lane.size === null)) pending.delete(key);
        }),
      ),
      lock.withPermits(1),
    );

  const write = (ref: TerminalRef, data: string) =>
    Effect.suspend(() => {
      const key = encodeTerminalKey(ref);
      laneOf(key).data += data;
      return flush(key);
    });

  const resize = (ref: TerminalRef, size: TerminalSize) =>
    Effect.suspend(() => {
      const key = encodeTerminalKey(ref);
      laneOf(key).size = { cols: size.cols, rows: size.rows };
      return flush(key);
    });

  return { write, resize };
};

export const makeTerminalAtoms = (runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>) => {
  /** One tick per connected epoch: mount, and every reconnect after that. */
  const connectedEpochs = Effect.gen(function* () {
    const state = yield* ConnectionStateRef;
    return SubscriptionRef.changes(state).pipe(
      Stream.map((connection) => connection.status),
      // `markConnected` rewrites the same status with the server's boot id;
      // dedupe on the status alone so that is not a second listing.
      Stream.changes,
      Stream.filter((status) => status === "connected"),
    );
  }).pipe(Stream.unwrap);

  /** A listing, taken again on every connected epoch, with a failure as a value. */
  const listingAtom = (
    listing: Effect.Effect<ReadonlyArray<TerminalSummary>, TerminalRpcError, Connection>,
  ) =>
    runtime.atom(
      connectedEpochs.pipe(
        Stream.mapEffect(() =>
          listing.pipe(
            Effect.map((terminals): TerminalListQuery => ({ _tag: "ok", terminals })),
            Effect.catch((error) =>
              Effect.succeed<TerminalListQuery>({ _tag: "error", message: error.message }),
            ),
          ),
        ),
      ),
    );

  /** Keyed by `terminalOwnerKey`: a thread's bare id, a project's key, or home's. */
  const terminalListAtom = Atom.family((ownerKey: string) =>
    listingAtom(
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["terminal.list"](decodeTerminalOwnerKey(ownerKey));
      }),
    ),
  );

  const runningTerminalsAtom = listingAtom(
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      return yield* client["terminal.listRunning"]({});
    }),
  );

  /** Rereads an owner's list and the running listing after a call that changed them. */
  const refetch = (registry: AtomRegistry.AtomRegistry, ...owners: ReadonlyArray<TerminalOwner>) =>
    Effect.sync(() => {
      for (const owner of owners) registry.refresh(terminalListAtom(terminalOwnerKey(owner)));
      registry.refresh(runningTerminalsAtom);
    });

  /**
   * Starts the shell, or answers the one already running under this id, and
   * resolves with that terminal's summary. The list is refetched whatever the
   * outcome: it is the truth either way.
   */
  const openTerminal = (
    registry: AtomRegistry.AtomRegistry,
    { title, script, ...args }: TerminalOpenArgs,
  ) =>
    runOneShot(runtime, registry, () =>
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["terminal.open"]({
          ...args,
          ...(title === undefined ? {} : { title }),
          ...(script === undefined ? {} : { script }),
        });
      }).pipe(Effect.ensuring(refetch(registry, args))),
    );

  /** Kills the shell and forgets it; the list is refetched whatever the outcome. */
  const closeTerminal = runtime.fn(
    (ref: TerminalRef, get) =>
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        yield* client["terminal.close"](refOf(ref));
      }).pipe(Effect.ensuring(refetch(get.registry, ref))),
    { concurrent: true },
  );

  /**
   * Hands the project's terminals to a local thread just started from it,
   * answering with them as the thread's. Both lists are refetched whatever
   * the outcome. Not `concurrent`, like `listTerminals`: see the note on the
   * two in the module doc.
   */
  const adoptTerminals = runtime.fn(
    (args: { readonly projectId: ProjectId; readonly threadId: ThreadId }, get) =>
      Effect.gen(function* () {
        const client = yield* (yield* Connection).client;
        return yield* client["terminal.adopt"]({
          projectId: args.projectId,
          threadId: args.threadId,
        });
      }).pipe(
        Effect.ensuring(
          refetch(get.registry, { projectId: args.projectId }, { threadId: args.threadId }),
        ),
      ),
  );

  /**
   * One `terminal.list`, answered once rather than kept current — for a
   * caller that has to know what the server holds now, as the New task
   * hand-over does after an adopt whose reply was lost. Keyed like
   * `terminalListAtom`.
   */
  const listTerminals = runtime.fn((ownerKey: string) =>
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      return yield* client["terminal.list"](decodeTerminalOwnerKey(ownerKey));
    }),
  );

  const lanes = makeInputLanes();

  /** Typed keys or a paste, delivered to the shell in the order they were written. */
  const writeTerminal = runtime.fn(
    (args: TerminalRef & { readonly data: string }) => lanes.write(refOf(args), args.data),
    { concurrent: true },
  );

  /** A new grid size; sizes queued behind an in-flight call collapse to the latest. */
  const resizeTerminal = runtime.fn(
    (args: TerminalRef & TerminalSize) => lanes.resize(refOf(args), args),
    { concurrent: true },
  );

  /**
   * One terminal's output, keyed by `encodeTerminalKey`. Set it with the
   * callback that feeds the renderer's terminal; set it again (or reset it) to
   * stop. Not concurrent on purpose: a new callback replaces the old one.
   */
  const terminalAttachAtom = Atom.family((key: string) =>
    runtime.fn((onItem: (item: TerminalAttachItem) => void) =>
      attach(decodeTerminalKey(key), onItem),
    ),
  );

  return {
    terminalListAtom,
    runningTerminalsAtom,
    openTerminal,
    writeTerminal,
    resizeTerminal,
    closeTerminal,
    adoptTerminals,
    listTerminals,
    terminalAttachAtom,
  };
};

export type TerminalAtoms = ReturnType<typeof makeTerminalAtoms>;

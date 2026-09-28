/**
 * Message search's half of the client runtime: one atom per query.
 *
 * `messageSearchAtom(query)` is a `threads.searchMessages` call keyed by the
 * query itself. The palette reads the member for its current (debounced)
 * query, so a new keystroke is a different member: the old one loses its last
 * subscriber, the registry disposes it, and disposing interrupts the fiber
 * holding its call — which cancels the RPC on the wire. Nothing has to track
 * the request in flight by hand.
 *
 * The shape follows `fsAtoms`, for the same two reasons:
 *
 * 1. The atom is a **stream driven by the connection's status**, so a palette
 *    opened while connected searches immediately and a reconnect searches
 *    again by itself. Offline the stream stays silent and the atom stays
 *    `Initial`.
 * 2. A failed call is a **value**, not the atom's error channel, so the
 *    palette can show it as a row beside the title hits instead of losing the
 *    group.
 *
 * A query under `MESSAGE_SEARCH_MIN_LENGTH` characters matches nothing on the
 * server, so it answers an empty list at once and never asks.
 */

import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import { MESSAGE_SEARCH_MIN_LENGTH, type MessageSearchHit } from "@poseidon/contracts/search";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Atom from "effect/unstable/reactivity/Atom";

import { Connection, ConnectionStateRef } from "./connection";

/** A search outcome as a value. */
export type MessageSearchQuery =
  | { readonly _tag: "ok"; readonly hits: ReadonlyArray<MessageSearchHit> }
  | { readonly _tag: "error"; readonly message: string };

const NO_HITS: MessageSearchQuery = { _tag: "ok", hits: [] };

/** True when `query` is long enough for the server to match anything. */
export const isSearchableQuery = (query: string): boolean =>
  Array.from(query.trim()).length >= MESSAGE_SEARCH_MIN_LENGTH;

export const makeSearchAtoms = (runtime: Atom.AtomRuntime<Connection | ConnectionStateRef>) => {
  /** One tick per connected epoch: mount, and every reconnect after that. */
  const connectedEpochs = Effect.gen(function* () {
    const state = yield* ConnectionStateRef;
    return SubscriptionRef.changes(state).pipe(
      Stream.map((connection) => connection.status),
      // `markConnected` rewrites the same status with the server's boot id;
      // dedupe on the status alone so that is not a second search.
      Stream.changes,
      Stream.filter((status) => status === "connected"),
    );
  }).pipe(Stream.unwrap);

  const search = (query: string) =>
    Effect.gen(function* () {
      const client = yield* (yield* Connection).client;
      return yield* client["threads.searchMessages"]({ query });
    }).pipe(
      Effect.map((hits): MessageSearchQuery => ({ _tag: "ok", hits })),
      Effect.catch((error) =>
        Effect.succeed<MessageSearchQuery>({
          _tag: "error",
          message:
            error instanceof PoseidonRpcError && error.code !== "internal"
              ? error.message
              : "Could not search messages.",
        }),
      ),
    );

  /** The palette's handle: one atom per query, disposed with its last reader. */
  const messageSearchAtom = Atom.family((query: string) => {
    const trimmed = query.trim();
    return runtime.atom(
      isSearchableQuery(trimmed)
        ? connectedEpochs.pipe(Stream.mapEffect(() => search(trimmed)))
        : Stream.succeed(NO_HITS),
    );
  });

  return { messageSearchAtom };
};

export type SearchAtoms = ReturnType<typeof makeSearchAtoms>;

/**
 * The latest initialize handshake per configuration, shared by the probe and
 * the instances opened with that configuration.
 *
 * Both ask the same CLI the same question (`readInitialization`), so what one
 * learns the other uses: a probe — at boot, on refresh, on "Probe all" —
 * replaces the answer an instance lists its models and slash commands from,
 * and an instance that asked again replaces the one the next probe falls back
 * on. A provisional answer (the CLI's compiled-in list, `probe.ts`) never
 * replaces a full one from the same account; it is kept only while nothing
 * better has been heard for it. An answer from another account or sign-in
 * state — after the user signs in, out, or switches — always replaces it: the
 * old list is not this CLI's any more.
 *
 * A model the user may have picked from the compiled-in list is not always in
 * the catalog under the same id (the compiled-in Fable is
 * `claude-fable-5-1[1m]`, the catalog's `claude-fable-5-1`). Such rows are
 * carried over into the answers that replace it, marked hidden, so a thread
 * or default already on one keeps its label and effort ladder while the
 * pickers no longer offer it.
 *
 * Each record says who made it, so an instance can tell a provisional answer
 * it should ask again about from one its own asking again produced.
 */

import type { ModelOption } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { Initialization } from "./probe";

/** Who ran the handshake an answer came from. */
export type HandshakeSource = "probe" | "instance" | "retry";

export interface Recorded {
  /** The answer to use: the handshake's, with any rows carried over appended. */
  readonly answer: Initialization;
  readonly source: HandshakeSource;
  /** The rows carried over from an earlier compiled-in list, hidden. */
  readonly carried: ReadonlyArray<ModelOption>;
}

export interface Handshakes {
  /** The answers kept for one configuration, starting with the current one (`null` before any). */
  readonly of: (key: string) => Effect.Effect<SubscriptionRef.SubscriptionRef<Recorded | null>>;
  /**
   * Records what a handshake answered and returns the answer to use: the one
   * kept, which is the new one unless it is provisional and a full one from
   * the same account is already known.
   */
  readonly record: (
    key: string,
    answer: Initialization,
    source: HandshakeSource,
  ) => Effect.Effect<Initialization>;
}

/** The key one configuration's answers are shared under. */
export const handshakeKey = (config: unknown): string => JSON.stringify(config ?? {});

/** Whose list an answer is: its account and whether it is signed in at all. */
export const holderOf = (answer: Initialization): string =>
  JSON.stringify([answer.signedIn, answer.account ?? null]);

/**
 * The rows an earlier answer listed that `answer` does not, hidden: the
 * compiled-in list's own when that is what it was, else what it carried. None
 * once the account changes.
 */
const carriedOver = (
  current: Recorded | null,
  answer: Initialization,
): ReadonlyArray<ModelOption> => {
  if (current === null || holderOf(current.answer) !== holderOf(answer)) return [];
  const earlier = current.answer.provisional ? current.answer.models : current.carried;
  const listed = new Set(answer.models.map((model) => model.id));
  return earlier
    .filter((model) => !listed.has(model.id))
    .map((model) => ({ ...model, hidden: true }));
};

export const makeHandshakes = (): Handshakes => {
  const byKey = new Map<string, SubscriptionRef.SubscriptionRef<Recorded | null>>();
  const creating = Semaphore.makeUnsafe(1);

  const of = (key: string) =>
    creating.withPermits(1)(
      Effect.gen(function* () {
        const existing = byKey.get(key);
        if (existing !== undefined) return existing;
        const made = yield* SubscriptionRef.make<Recorded | null>(null);
        byKey.set(key, made);
        return made;
      }),
    );

  const record = (key: string, answer: Initialization, source: HandshakeSource) =>
    Effect.flatMap(of(key), (ref) =>
      SubscriptionRef.modify(ref, (current): [Initialization, Recorded | null] => {
        if (
          answer.provisional &&
          current !== null &&
          !current.answer.provisional &&
          holderOf(current.answer) === holderOf(answer)
        ) {
          return [current.answer, current];
        }
        const carried = answer.provisional ? [] : carriedOver(current, answer);
        const kept =
          carried.length === 0 ? answer : { ...answer, models: [...answer.models, ...carried] };
        return [kept, { answer: kept, source, carried }];
      }),
    );

  return { of, record };
};

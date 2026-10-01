/**
 * The latest initialize handshake per configuration, shared by the probe and
 * the instances opened with that configuration.
 *
 * Both ask the same CLI the same question (`readInitialization`), so what one
 * learns the other uses: a probe — at boot, on refresh, on "Probe all" —
 * replaces the answer an instance lists its models and slash commands from,
 * and an instance that asked again replaces the one the next probe falls back
 * on. A provisional answer (the CLI's compiled-in list, `probe.ts`) never
 * replaces a full one; it is kept only while nothing better has been heard.
 *
 * Each record says who made it, so an instance can tell a provisional answer
 * it should ask again about from one its own asking again produced.
 */

import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { Initialization } from "./probe";

/** Who ran the handshake an answer came from. */
export type HandshakeSource = "probe" | "instance" | "retry";

export interface Recorded {
  readonly answer: Initialization;
  readonly source: HandshakeSource;
}

export interface Handshakes {
  /** The answers kept for one configuration, starting with the current one (`null` before any). */
  readonly of: (key: string) => Effect.Effect<SubscriptionRef.SubscriptionRef<Recorded | null>>;
  /**
   * Records what a handshake answered and returns the answer to use: the one
   * kept, which is the new one unless it is provisional and a full one is
   * already known.
   */
  readonly record: (
    key: string,
    answer: Initialization,
    source: HandshakeSource,
  ) => Effect.Effect<Initialization>;
}

/** The key one configuration's answers are shared under. */
export const handshakeKey = (config: unknown): string => JSON.stringify(config ?? {});

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
      SubscriptionRef.modify(ref, (current): [Initialization, Recorded | null] =>
        answer.provisional && current !== null && !current.answer.provisional
          ? [current.answer, current]
          : [answer, { answer, source }],
      ),
    );

  return { of, record };
};

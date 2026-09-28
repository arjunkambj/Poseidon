/**
 * A one-shot write on the app's runtime: one call, one result, nothing shared.
 *
 * A `runtime.fn` atom holds a single call. Setting it again rebuilds the atom,
 * which interrupts the call still running, and a `promiseExit` setter reads
 * whatever the atom holds when it settles — so of two overlapping calls the
 * first is cut short on the server and its caller gets the second's result.
 * That is fine for a write only one surface ever makes at a time; it is wrong
 * for the git writes, where two threads can each commit or push, or two
 * deleted threads each remove a worktree, at once.
 *
 * `runOneShot` builds a fresh atom per call instead, holds it mounted until
 * the call settles and lets the registry drop it after. Calls run side by
 * side, each resolves with its own `Exit`, and none depends on the component
 * that started it staying mounted. An aborted `signal` stops the call: the
 * atom loses its last subscriber, so the registry drops it and interrupts
 * what it runs, and the promise resolves with the interruption.
 */

import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import type * as Atom from "effect/unstable/reactivity/Atom";
import type * as Reactivity from "effect/unstable/reactivity/Reactivity";

export const runOneShot = <R, ER, A, E>(
  runtime: Atom.AtomRuntime<R, ER>,
  registry: AtomRegistry.AtomRegistry,
  body: (
    get: Atom.AtomContext,
  ) => Effect.Effect<A, E, R | Scope.Scope | AtomRegistry.AtomRegistry | Reactivity.Reactivity>,
  options?: { readonly signal?: AbortSignal },
): Promise<Exit.Exit<A, E | ER>> =>
  Effect.runPromiseExit(
    AtomRegistry.getResult(registry, runtime.atom(body), { suspendOnWaiting: true }),
    options?.signal === undefined ? undefined : { signal: options.signal },
  );

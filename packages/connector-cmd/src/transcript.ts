/**
 * The on-disk session transcript.
 *
 * Command Code writes `~/.commandcode/projects/<slug>/<sessionId>.jsonl`. The
 * connector tails that file by byte offset and parses complete `\n`-terminated
 * lines only — a partial write is held until its newline lands.
 *
 * Two things the real 1.55.1 install taught us, both recorded in
 * `packages/testkit/fixtures/cmd/`:
 *
 * - `slugFor` is a guess and it is wrong. Every recording's manifest has
 *   `transcriptDirMatchesConnectorSlug: false`. The session is therefore found
 *   by the one identifier the harness hands us — its id — with the slug kept
 *   only as the first guess. See `findTranscriptPath`.
 * - The file does not exist at `run_start`. It appears seconds into the turn,
 *   already holding the run's first lines, and thereafter grows once per
 *   completed message rather than per token. So the tailer polls (fs.watch on a
 *   not-yet-existing path is exactly the case the platforms disagree on), takes
 *   a locator rather than a path, and reads a file born under its watch from
 *   byte zero.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** How often the tailer re-reads the file for appended bytes. */
export const TAIL_POLL_MS = 50;

/** The transcript directory name under the harness's config dir. */
const slugFor = (cwd: string): string => {
  const slug = cwd.toLowerCase().replaceAll("/", "-");
  return slug.startsWith("-") ? slug.slice(1) : slug;
};

/**
 * `~/.commandcode/projects/<slug>` for a session running in `cwd`. `home`
 * overrides the home directory — tests point it at a temp dir; sessions leave
 * it out so `HOME` (and the harness's own resolution) stays authoritative.
 */
export const transcriptDirFor = (cwd: string, home?: string): string =>
  NodePath.join(home ?? NodeOS.homedir(), ".commandcode", "projects", slugFor(cwd));

export const transcriptPathFor = (cwd: string, sessionId: string, home?: string): string =>
  NodePath.join(transcriptDirFor(cwd, home), `${sessionId}.jsonl`);

/** `~/.commandcode/projects`. */
export const projectsRootFor = (home?: string): string =>
  NodePath.join(home ?? NodeOS.homedir(), ".commandcode", "projects");

/**
 * Where the harness really put this session's transcript.
 *
 * `slugFor` is a guess at a private naming scheme, and a real 1.55.1 install
 * disproves it: some camel-cased directory names come back with the hump split
 * into a dash, while `/Users/<user>/Code/SettlerSaga` becomes
 * `users-<user>-code-settlersaga`, which is not. Rather than reimplement a rule
 * we cannot see, we look the session up by the one identifier the harness
 * already handed us: `run_start.sessionId` is unique, so the file is the
 * `<sessionId>.jsonl` under whichever project directory holds it. The slug
 * stays as the first guess because it is right often enough to skip the scan.
 *
 * Returns null while the harness has not created the file yet — it appears
 * seconds into the turn, not at `run_start`.
 */
export const findTranscriptPath = (
  cwd: string,
  sessionId: string,
  home?: string,
): string | null => {
  const guess = transcriptPathFor(cwd, sessionId, home);
  if (NodeFS.existsSync(guess)) {
    return guess;
  }
  const root = projectsRootFor(home);
  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = NodePath.join(root, entry.name, `${sessionId}.jsonl`);
    if (NodeFS.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

export interface TranscriptTail {
  /** Complete `\n`-terminated lines, in file order, from the start offset on. */
  readonly lines: Stream.Stream<string>;
  /** Stops the reader and ends the stream. Idempotent. */
  readonly stop: Effect.Effect<void>;
}

export interface TailOptions {
  /**
   * Where to begin. `false` (default) starts at the file's current end: the
   * tailer follows new appends only, so a resumed session does not replay its
   * whole history into the timeline. `true` reads the file from byte zero,
   * which is what a test against a pre-seeded fixture wants.
   */
  readonly fromStart?: boolean;
  /**
   * Resume marker from the persisted sessionRef: a transcript line `id` or a
   * message's `meta.messageId`. When set and found, the tailer starts right
   * after that line — catching up whatever a dead server missed without
   * replaying what was already emitted. Unset or unfound → start at EOF.
   */
  readonly afterMessageId?: string;
  readonly pollMs?: number;
}

interface ReadResult {
  readonly data: string;
  readonly size: number;
}

/** The bytes after `offset`, or null when the file does not exist (yet). */
const readFrom = (path: string, offset: number): ReadResult | null => {
  let fd: number;
  try {
    fd = NodeFS.openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = NodeFS.fstatSync(fd);
    if (size < offset) {
      // Truncated or replaced — a fresh session file under the same name.
      return { data: "", size: 0 };
    }
    if (size === offset) {
      return { data: "", size };
    }
    const buffer = Buffer.alloc(size - offset);
    const read = NodeFS.readSync(fd, buffer, 0, size - offset, offset);
    return { data: buffer.toString("utf8", 0, read), size };
  } finally {
    NodeFS.closeSync(fd);
  }
};

/**
 * The byte offset just after the line carrying `marker` — matched against the
 * transcript line's `id` and its nested `meta.messageId` — or null when the
 * file is unreadable or the marker is absent (a truncated/recreated file).
 */
const offsetAfterMarker = (path: string, marker: string): number | null => {
  let data: string;
  try {
    data = NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let offset = 0;
  for (const line of data.split("\n")) {
    const next = offset + Buffer.byteLength(line, "utf8") + 1;
    if (line.length > 0) {
      try {
        const record = JSON.parse(line) as {
          readonly id?: unknown;
          readonly message?: { readonly meta?: { readonly messageId?: unknown } };
        };
        if (record.id === marker || record.message?.meta?.messageId === marker) {
          return next;
        }
      } catch {
        // An unparseable line can't carry the marker — keep scanning.
      }
    }
    offset = next;
  }
  return null;
};

/**
 * Tails `path` by byte offset. Bound to the surrounding scope: closing the
 * scope, or calling `stop`, ends the reader and the stream together.
 */
export const tailTranscript = (
  /**
   * The file, or a locator called on every poll until it finds one — the
   * harness creates the transcript seconds into the turn, so a session tails a
   * path that does not exist yet.
   */
  path: string | (() => string | null),
  options: TailOptions = {},
): Effect.Effect<TranscriptTail, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<string, Cause.Done>({ capacity: 8192 });
    const stopped = yield* Deferred.make<void>();
    // The unterminated tail lives in a Ref so `stop` can flush what the loop
    // still holds — a final entry that never got its newline must not be
    // silently dropped.
    const pending = yield* Ref.make("");
    const flushTail = Ref.getAndSet(pending, "").pipe(
      Effect.flatMap((tail) => (tail.length > 0 ? Queue.offer(queue, tail) : Effect.void)),
      Effect.asVoid,
    );

    const pollMs = options.pollMs ?? TAIL_POLL_MS;

    const locate = typeof path === "string" ? () => path : path;
    // The file is bound the first time the locator finds it; until then there
    // is nothing to read and nothing to position.
    let resolved: string | null = null;
    let offset = 0;

    /**
     * "Current byte offset" is decided once, when the file first resolves.
     *
     * A file that was *already there* when the tailer started holds a previous
     * run's history: it is skipped to end, or to just after the resume marker
     * when one is given and found — the lines between marker and EOF are what a
     * dead server never saw.
     *
     * A file that appeared *while we were watching* is this run's own, and
     * every byte in it is ours even though it was born with content: the
     * harness creates the transcript seconds into the turn and writes the user
     * message into it immediately, so skipping to end here would silently drop
     * the opening lines of every session. It starts at byte zero — except on a
     * resume, where the marker still wins if the file carries it.
     */
    const positionIn = (file: string, bornWhileWatching: boolean): number => {
      if (options.fromStart === true) {
        return 0;
      }
      if (options.afterMessageId !== undefined) {
        const marked = offsetAfterMarker(file, options.afterMessageId);
        if (marked !== null) {
          return marked;
        }
      }
      if (bornWhileWatching) {
        return 0;
      }
      const initial = readFrom(file, 0);
      return initial === null ? 0 : initial.size;
    };

    // Position eagerly when the file is already there, before anything is
    // forked: a caller that appends right after `tailTranscript` returns must
    // see those lines as appends, not have them swallowed by a later skip.
    yield* Effect.sync(() => {
      const found = locate();
      if (found !== null) {
        resolved = found;
        offset = positionIn(found, false);
      }
    });

    const loop = Effect.gen(function* () {
      while (true) {
        if (resolved === null) {
          const found = yield* Effect.sync(locate);
          if (found === null) {
            yield* Effect.sleep(pollMs);
            continue;
          }
          resolved = found;
          offset = yield* Effect.sync(() => positionIn(found, true));
        }
        const file = resolved;
        const result = yield* Effect.sync(() => readFrom(file, offset));
        if (result !== null) {
          if (result.size < offset) {
            // Truncated or replaced — a fresh session file under the same name.
            offset = 0;
            yield* Ref.set(pending, "");
          } else {
            offset = result.size;
            const merged = (yield* Ref.get(pending)) + result.data;
            const lines = merged.split("\n");
            yield* Ref.set(pending, lines.pop() ?? "");
            for (const line of lines) {
              if (line.length > 0) {
                yield* Queue.offer(queue, line);
              }
            }
          }
        }
        yield* Effect.sleep(pollMs);
      }
    }).pipe(
      // Interrupted or stopped, the loop flushes whatever tail it held.
      Effect.ensuring(flushTail),
    );

    const fiber = yield* Effect.forkScoped(Effect.raceFirst(loop, Deferred.await(stopped)));

    const stop = Effect.gen(function* () {
      yield* Deferred.succeed(stopped, undefined);
      // Await the reader before ending the queue so its tail flush lands first.
      yield* Fiber.await(fiber);
      yield* flushTail; // no-op once the loop's ensuring already flushed
      yield* Queue.end(queue);
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* stop;
        yield* Fiber.await(fiber);
      }),
    );

    return { lines: Stream.fromQueue(queue), stop };
  });

/** Whether a transcript line is a message, as opposed to a header or anything else. */
export const isMessageLine = (line: string): boolean => {
  try {
    return (JSON.parse(line) as { readonly type?: unknown } | null)?.type === "message";
  } catch {
    return false;
  }
};

/**
 * Every non-blank line of a session's transcript, or none when there is no
 * file to read.
 *
 * Two callers want the whole file rather than a tail: the seed a resumed
 * session runs before its first turn, and the drain that runs before a turn is
 * allowed to settle. The path is looked up by session id — the harness's
 * project-directory slug is not the one `slugFor` guesses — and `fallback` is
 * the path a persisted ref remembers, for the case where the lookup misses.
 */
export const readTranscriptLines = (
  root: string,
  sessionId: string,
  home?: string,
  fallback?: string,
): ReadonlyArray<string> => {
  const path = findTranscriptPath(root, sessionId, home) ?? fallback;
  if (path === undefined) {
    return [];
  }
  try {
    return NodeFS.readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
};

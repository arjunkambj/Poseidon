/**
 * Pull requests through the GitHub CLI.
 *
 * `gh` is an ordinary tool the user installs and signs in to, so it sits
 * behind `GhRunner`: the real layer spawns it, a test hands in a runner that
 * answers with gh's own wording. `createPullRequest` is the whole flow — is
 * gh there, is it signed in, open the pull request, or find the one that is
 * already open — and classifies each way it can end; `pullRequestBlocker` is
 * its first half alone, for the header to ask before it offers Create PR.
 *
 * Every call is argv form, never a shell, so a title or body is only ever an
 * argument.
 */
import { execFile } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { GitPullRequestResult } from "@poseidon/contracts/git";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PoseidonRpcError } from "@poseidon/contracts/rpc";

/** `gh` could not be started at all: it is not installed, or not where we looked. */
export class GhMissing extends Data.TaggedError("GhMissing")<{ readonly message: string }> {}

export interface GhOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GhRunner extends Context.Service<
  GhRunner,
  {
    /** Runs `gh <args>` in `cwd`. A non-zero exit is an answer, not a failure. */
    readonly run: (args: ReadonlyArray<string>, cwd: string) => Effect.Effect<GhOutput, GhMissing>;
  }
>()("server/git/GhRunner") {
  static readonly layer = Layer.sync(GhRunner, () => GhRunner.of({ run: runGh }));
}

// ── The real runner ────────────────────────────────────────────

/**
 * Where a package manager puts `gh` when the server's own PATH does not say.
 * An app launched from Finder inherits launchd's `/usr/bin:/bin:/usr/sbin:/sbin`,
 * which holds neither Homebrew prefix, so looking only at PATH would report
 * gh missing on exactly the machines that have it.
 */
const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

const isExecutable = (path: string): boolean => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

/** `gh` on PATH, then in the directories a GUI launch leaves out. Looked up per call. */
const resolveGh = (): string | null => {
  const dirs = [...(process.env.PATH ?? "").split(NodePath.delimiter), ...EXTRA_BIN_DIRS];
  for (const dir of dirs) {
    if (dir.length === 0) continue;
    const candidate = NodePath.join(dir, "gh");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
};

/** Long enough for a slow API round trip, short enough that a stall is reported. */
const GH_TIMEOUT_MS = 2 * 60 * 1000;

const NOT_AVAILABLE = "gh not available: install the GitHub CLI and run gh auth login";

const runGh = (args: ReadonlyArray<string>, cwd: string): Effect.Effect<GhOutput, GhMissing> =>
  Effect.callback<GhOutput, GhMissing>((resume) => {
    const binary = resolveGh();
    if (binary === null) {
      resume(Effect.fail(new GhMissing({ message: NOT_AVAILABLE })));
      return;
    }
    const child = execFile(
      binary,
      [...args],
      {
        cwd,
        // No prompt can be answered from here: gh must fail instead of asking,
        // and so must any git it runs underneath.
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
        timeout: GH_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null && error.code === "ENOENT") {
          resume(Effect.fail(new GhMissing({ message: NOT_AVAILABLE })));
          return;
        }
        if (error !== null && typeof error.code !== "number") {
          // Killed (the timeout) or never produced an exit status: an answer
          // that failed, with the reason where gh's stderr would be.
          const reason = error.killed ? "gh timed out" : error.message;
          resume(Effect.succeed({ stdout, stderr: stderr || reason, exitCode: 1 }));
          return;
        }
        const exitCode = typeof error?.code === "number" ? error.code : 0;
        resume(Effect.succeed({ stdout, stderr, exitCode }));
      },
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });

// ── Creating a pull request ────────────────────────────────────

const unavailable = (message: string) => new PoseidonRpcError({ code: "unavailable", message });

const NOT_AUTHENTICATED =
  "gh is not authenticated: run gh auth login in a terminal, then try again.";

/**
 * Why gh cannot open a pull request from `cwd`, or `null` when it is
 * installed and signed in. The header asks before it offers Create PR, and
 * `createPullRequest` asks again, since gh can be signed out in between.
 */
export const pullRequestBlocker = (
  gh: GhRunner["Service"],
  cwd: string,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const version = yield* gh.run(["--version"], cwd);
    if (version.exitCode !== 0) return NOT_AVAILABLE;
    const auth = yield* gh.run(["auth", "status"], cwd);
    return auth.exitCode === 0 ? null : NOT_AUTHENTICATED;
  }).pipe(Effect.catchTag("GhMissing", () => Effect.succeed(NOT_AVAILABLE)));

/** The last pull-request URL in some gh output, e.g. `https://github.com/o/r/pull/12`. */
const pullRequestUrl = (text: string): string | null => {
  const matches = text.match(/https?:\/\/\S+\/pull\/\d+/g);
  return matches === null ? null : matches[matches.length - 1]!;
};

/** gh's refusal when the branch already has an open pull request into that base. */
const ALREADY_EXISTS = /already exists/i;

/**
 * Opens a pull request from `head` into `base`, or answers the one already
 * open for `head` (`created: false`). `unavailable` when gh is not installed
 * or not signed in; `conflict` with gh's own words for any other refusal (no
 * commits between the branches, a head that was never pushed).
 */
export const createPullRequest = (
  gh: GhRunner["Service"],
  cwd: string,
  options: {
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
  },
): Effect.Effect<GitPullRequestResult, PoseidonRpcError> =>
  Effect.gen(function* () {
    const blocker = yield* pullRequestBlocker(gh, cwd);
    if (blocker !== null) {
      return yield* Effect.fail(unavailable(blocker));
    }
    const created = yield* gh.run(
      [
        "pr",
        "create",
        "--head",
        options.head,
        "--base",
        options.base,
        "--title",
        options.title,
        "--body",
        options.body,
      ],
      cwd,
    );
    if (created.exitCode === 0) {
      const url = pullRequestUrl(created.stdout);
      if (url !== null) return { url, created: true };
    } else if (!ALREADY_EXISTS.test(created.stderr)) {
      return yield* Effect.fail(
        new PoseidonRpcError({
          code: "conflict",
          message: created.stderr.trim() || `gh pr create exited ${created.exitCode}`,
        }),
      );
    }
    // Already open (or created without a URL on stdout): gh names it in its
    // refusal; failing that, ask for the branch's pull request directly.
    const named = created.exitCode === 0 ? null : pullRequestUrl(created.stderr);
    if (named !== null) return { url: named, created: false };
    const viewed = yield* gh.run(["pr", "view", options.head, "--json", "url", "-q", ".url"], cwd);
    const url = viewed.exitCode === 0 ? pullRequestUrl(viewed.stdout) : null;
    if (url === null) {
      return yield* Effect.fail(
        new PoseidonRpcError({
          code: "internal",
          message: `gh did not report the pull request's URL: ${viewed.stderr.trim()}`,
        }),
      );
    }
    return { url, created: created.exitCode === 0 };
  }).pipe(
    // However the runner worded it, a gh that cannot start gets the one fix.
    Effect.catchTag("GhMissing", () => Effect.fail(unavailable(NOT_AVAILABLE))),
  );

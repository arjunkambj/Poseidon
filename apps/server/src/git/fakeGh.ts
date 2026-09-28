/**
 * A `GhRunner` for tests: it answers from a script with the wording gh 2.92
 * prints and records every argv it was handed, so no test ever talks to
 * GitHub. Imported by the test files only.
 */
import * as Effect from "effect/Effect";

import { GhMissing, GhRunner, type GhOutput } from "./GitHubCli";

/** What gh 2.92 prints, captured from the real binary (the token masked as gh masks it). */
export const GH_VERSION: GhOutput = {
  stdout: "gh version 2.92.0 (2026-04-28)\nhttps://github.com/cli/cli/releases/tag/v2.92.0\n",
  stderr: "",
  exitCode: 0,
};
export const GH_AUTHENTICATED: GhOutput = {
  stdout: [
    "github.com",
    "  ✓ Logged in to github.com account octo (keyring)",
    "  - Active account: true",
    "  - Git operations protocol: https",
    "  - Token: gho_************************************",
    "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
    "",
  ].join("\n"),
  stderr: "",
  exitCode: 0,
};
export const GH_NOT_AUTHENTICATED: GhOutput = {
  stdout: "",
  stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
  exitCode: 1,
};

type GhScript = (args: ReadonlyArray<string>, cwd: string) => GhOutput | "missing";

/** A runner that answers from `script` and records every argv it was handed. */
export const fakeGh = (script: GhScript) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runner = GhRunner.of({
    run: (args, cwd) =>
      Effect.suspend(() => {
        calls.push(args);
        const answer = script(args, cwd);
        return answer === "missing"
          ? Effect.fail(new GhMissing({ message: "spawn gh ENOENT" }))
          : Effect.succeed(answer);
      }),
  });
  return { runner, calls };
};

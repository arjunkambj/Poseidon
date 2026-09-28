/**
 * The environment a Codex child runs with — default deny.
 *
 * The child is spawned with exactly what this returns: a short list of names
 * a CLI legitimately needs, the `LC_*` locales, and `CODEX_HOME` when the
 * instance names an account of its own. Nothing else is inherited.
 *
 * Poseidon can itself be started from inside another agent's session — a
 * Codex session sets `CODEX_*` variables of its own (its home, its sandbox
 * markers), and a Claude Code session sets `CLAUDECODE` and a few dozen
 * `CLAUDE_*` ones. Handed on, a parent's `CODEX_SANDBOX*` would make our child
 * believe it already runs sandboxed, and a parent's `CODEX_HOME` would point
 * it at an account the instance never chose. So these, the API credentials
 * (`OPENAI_*`, `ANTHROPIC_*`) and our own server's internals are dropped by
 * name as well as by omission: no later change to the allowlist can let one
 * through.
 *
 * `HOME` is inherited and never set here. A second account goes through
 * `CODEX_HOME`, which is the one directory the CLI reads its login from.
 */

import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Exact names the child keeps. The second row is what a CLI needs to reach the
 * network and git in the real world: the ssh agent for git-over-ssh inside
 * shell commands, and the proxy and CA variables its own API calls depend on.
 */
const BASE_ENV = new Set([
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
]);

/** Prefixes that pass: the locale variables. */
const PASS_PREFIXES = ["LC_"];

/**
 * What never reaches the child, whatever the allowlist says: a parent Codex
 * or Claude Code session's variables, API credentials, and our own server's
 * internals.
 */
const DROP_PREFIXES = ["CODEX_", "OPENAI_", "CLAUDE_", "ANTHROPIC_", "POSEIDON_SERVER_"];
const DROP_NAMES = new Set(["CLAUDECODE"]);

const isDropped = (name: string): boolean =>
  DROP_NAMES.has(name) || DROP_PREFIXES.some((prefix) => name.startsWith(prefix));

const isAllowed = (name: string): boolean =>
  !isDropped(name) &&
  (BASE_ENV.has(name) || PASS_PREFIXES.some((prefix) => name.startsWith(prefix)));

/** `~` and `~/…` against the user's home; anything else resolved as given. */
export const expandHome = (path: string, home: string = NodeOS.homedir()): string =>
  path === "~"
    ? home
    : path.startsWith("~/")
      ? NodePath.join(home, path.slice(2))
      : NodePath.resolve(path);

/**
 * The child's environment: the allowlisted inherited variables, then
 * `CODEX_HOME` from the instance's config. An inherited `CODEX_HOME` is
 * dropped with the rest — which account a session uses is the instance's
 * setting, not whatever shell Poseidon was started from.
 */
export const childEnv = (
  inherited: Readonly<Record<string, string | undefined>>,
  config: { readonly codexHome?: string | undefined },
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && isAllowed(name)) {
      out[name] = value;
    }
  }
  if (config.codexHome !== undefined && config.codexHome !== "") {
    out.CODEX_HOME = expandHome(config.codexHome, inherited.HOME ?? NodeOS.homedir());
  }
  return out;
};

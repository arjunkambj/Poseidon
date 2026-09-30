/**
 * Codex's own installed plugins, for the composer's `@` menu and the
 * Customize page. This is the `plugins` extension, and it only reads: the CLI
 * installs, enables and removes plugins (`codex plugin add`, `remove`), and
 * nothing here writes to its config.
 *
 * The list is the CLI's own, `codex plugin list --json` (`cli.ts`), whose
 * `installed` rows name each plugin, the marketplace it came from, whether it
 * is enabled, and its source directory; the marketplaces that only offer a
 * plugin (`available`, and only with `--available`) are left out. A row is
 * described by its source's `.codex-plugin/plugin.json` — the manifest's
 * `interface.shortDescription`, else its `description` — when the source is a
 * local directory that has one. Codex installs plugins for the user alone, so
 * every row is in the user scope and the project changes nothing.
 *
 * What the CLI prints comes from codex-cli 0.159.2 (`fixtures/codex/plugins/`).
 */

import { readFile } from "node:fs/promises";
import * as NodePath from "node:path";
import type { ExtensionScope, PluginsExtension } from "@poseidon/connector-sdk/extensions";
import type { PluginSummary } from "@poseidon/contracts/connectors";
import * as Effect from "effect/Effect";
import { isObject, isString } from "effect/Predicate";

import { cliError, failed, runCodex, type CodexCli } from "./cli";

const nonEmpty = (value: unknown): string | undefined =>
  isString(value) && value.trim() !== "" ? value.trim() : undefined;

/** One `installed` row, without its description; null when it names no plugin. */
export const toPluginSummary = (
  row: unknown,
): (PluginSummary & { readonly dir?: string }) | null => {
  if (!isObject(row)) return null;
  const name = nonEmpty(row.name);
  if (name === undefined || row.installed === false) return null;
  const source = isObject(row.source) ? row.source : {};
  const marketplace = nonEmpty(row.marketplaceName);
  const dir = source.source === "local" ? nonEmpty(source.path) : undefined;
  return {
    name,
    ...(marketplace === undefined ? {} : { source: marketplace }),
    scope: "user",
    enabled: row.enabled === true,
    ...(dir === undefined ? {} : { dir }),
  };
};

/** The manifest's one-line description, when the plugin's directory has a readable one. */
const descriptionOf = (dir: string): Effect.Effect<string | undefined> =>
  Effect.tryPromise(
    async () =>
      JSON.parse(
        await readFile(NodePath.join(dir, ".codex-plugin", "plugin.json"), "utf8"),
      ) as unknown,
  ).pipe(
    Effect.map((manifest) => {
      if (!isObject(manifest)) return undefined;
      const face = isObject(manifest.interface) ? manifest.interface : {};
      return nonEmpty(face.shortDescription) ?? nonEmpty(manifest.description);
    }),
    Effect.orElseSucceed(() => undefined),
  );

export const makeCodexPlugins = (cli: CodexCli): PluginsExtension => {
  const run = runCodex(cli);
  const listed = Effect.gen(function* () {
    const ran = yield* run(["plugin", "list", "--json"]);
    if (ran.code !== 0) return yield* failed("internal", cliError(ran.stderr));
    const printed = yield* Effect.try({
      try: () => JSON.parse(ran.stdout) as unknown,
      catch: () =>
        failed("internal", "codex plugin list --json printed something that is not JSON"),
    });
    const rows = isObject(printed) && Array.isArray(printed.installed) ? printed.installed : [];
    const out: Array<PluginSummary> = [];
    for (const row of rows) {
      const summary = toPluginSummary(row);
      if (summary === null) continue;
      const { dir, ...plugin } = summary;
      const description = dir === undefined ? undefined : yield* descriptionOf(dir);
      out.push(description === undefined ? plugin : { ...plugin, description });
    }
    return out;
  });
  return { list: (_scope: ExtensionScope) => listed };
};

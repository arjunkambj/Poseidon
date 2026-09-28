/**
 * Writes the plugins that ship with the app into the built-in plugins folder
 * (`POSEIDON_HOME/builtin-plugins/<name>`), where the registry discovers them
 * like any other plugin and a harness can be handed the directory.
 *
 * Called when the server boots, never when a layer is built: tests build the
 * layers, and writing here then would touch the developer's real home. A file
 * is written only when its content differs, so a restart leaves the folder
 * alone and an upgrade replaces exactly what changed.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import { BROWSER_PLUGIN_FILES, BROWSER_PLUGIN_NAME } from "./browser";

/** Every built-in plugin: its directory name and its files by relative path. */
const BUILTIN_PLUGINS: ReadonlyArray<{
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
}> = [{ name: BROWSER_PLUGIN_NAME, files: BROWSER_PLUGIN_FILES }];

/** Writes every built-in plugin under `dir` and answers the files it had to write. */
export const materializeBuiltins = async (dir: string): Promise<ReadonlyArray<string>> => {
  const written: Array<string> = [];
  for (const plugin of BUILTIN_PLUGINS) {
    for (const [relative, content] of Object.entries(plugin.files)) {
      const path = NodePath.join(dir, plugin.name, relative);
      const current = await readFile(path, "utf8").catch(() => null);
      if (current === content) {
        continue;
      }
      await mkdir(NodePath.dirname(path), { recursive: true });
      await writeFile(path, content);
      written.push(path);
    }
  }
  return written;
};

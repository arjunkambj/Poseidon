/**
 * The argv that opens a path in a detected app.
 *
 * The command always comes from the recipe `detect.ts` built or from the
 * platform's own opener (`/usr/bin/open`, `xdg-open`, `explorer.exe`), never
 * from a caller; the target is always an absolute path, so it cannot be read
 * as a flag. A line reaches an editor only through its CLI — `open -a` has no
 * way to pass one.
 */
import * as nodePath from "node:path";

import type { EditorRecipe } from "./detect";

const MAC_OPEN = "/usr/bin/open";

export interface LaunchInput {
  readonly platform: NodeJS.Platform;
  readonly recipe: EditorRecipe;
  /** Absolute and already held to the workspace root (`target.ts`). */
  readonly target: string;
  readonly isDirectory: boolean;
  readonly line?: number | undefined;
  readonly reveal?: boolean | undefined;
}

export interface Launch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * Windows only: pass `args` to the child as written, without Node's
   * quoting. Set when an argument quotes itself.
   */
  readonly verbatim?: true;
}

const editorArgs = (input: LaunchInput): ReadonlyArray<string> => {
  const { target, line, recipe } = input;
  if (line === undefined || input.isDirectory) return [target];
  return recipe.lineStyle === "goto" ? ["-g", `${target}:${line}`] : [`${target}:${line}`];
};

/** The folder a terminal starts in, or a file manager shows, for `target`. */
const folderOf = (input: LaunchInput): string =>
  input.isDirectory ? input.target : nodePath.dirname(input.target);

const fileManager = (input: LaunchInput): Launch | null => {
  const selects = input.reveal === true || !input.isDirectory;
  switch (input.platform) {
    case "darwin":
      return { command: MAC_OPEN, args: selects ? ["-R", input.target] : [input.target] };
    case "win32":
      // Explorer reads `/select,` only unquoted, so Node's quoting of an
      // argument with a space ("/select,C:\a b") would hide the switch and
      // open a default folder. The path is quoted by hand instead; a Windows
      // path cannot hold a quote.
      return selects
        ? { command: "explorer.exe", args: [`/select,"${input.target}"`], verbatim: true }
        : { command: "explorer.exe", args: [input.target] };
    default: {
      if (input.recipe.cli === undefined) return null;
      // `xdg-open` cannot select a file, so it opens the folder holding it.
      const folder = selects ? nodePath.dirname(input.target) : input.target;
      return { command: input.recipe.cli, args: [folder] };
    }
  }
};

/** The launch, or null for a recipe `detect.ts` never makes on this platform. */
export const buildLaunch = (input: LaunchInput): Launch | null => {
  const { recipe } = input;
  switch (recipe.kind) {
    case "file-manager":
      return fileManager(input);
    case "terminal":
      if (input.platform !== "darwin") return null;
      return { command: MAC_OPEN, args: ["-a", "Terminal", folderOf(input)] };
    case "editor":
      if (recipe.cli !== undefined) return { command: recipe.cli, args: editorArgs(input) };
      if (recipe.bundlePath !== undefined && input.platform === "darwin") {
        return { command: MAC_OPEN, args: ["-a", recipe.bundlePath, input.target] };
      }
      return null;
  }
};

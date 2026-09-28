/**
 * Which editors, file manager and terminal this machine has, and how each one
 * is launched.
 *
 * On macOS an app is found by its bundle in `/Applications` or
 * `~/Applications` first and its CLI on `PATH` second: an app started from the
 * Dock hands its children a minimal `PATH`, so the bundle — and the CLI that
 * ships inside it — is the answer that holds however Poseidon was started.
 * Linux has no bundles, so an editor there is its CLI on `PATH`. Windows
 * offers the file manager alone: its editor CLIs are `.cmd` shims, which only
 * a shell can run, and nothing here ever starts a shell.
 *
 * Pure: the caller hands in the platform, the home directory, the `PATH`
 * directories and an existence check, so a test can describe any machine.
 */
import * as nodePath from "node:path";
import type { DetectedEditor, EditorId, EditorKind } from "@poseidon/contracts/editors";

/**
 * How an editor takes a line: `goto` is the VS Code family's `-g file:line`,
 * `suffix` is a bare `file:line` (Zed, Sublime Text).
 */
export type LineStyle = "goto" | "suffix";

/** One detected app and everything `buildLaunch` needs to start it. */
export interface EditorRecipe {
  readonly id: EditorId;
  readonly label: string;
  readonly kind: EditorKind;
  /** The CLI's absolute path, when one was found; the only way to pass a line. */
  readonly cli?: string | undefined;
  /** The macOS app bundle, when one was found; opened with `open -a` when there is no CLI. */
  readonly bundlePath?: string | undefined;
  readonly lineStyle?: LineStyle | undefined;
}

export interface DetectInput {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** `PATH`, already split. */
  readonly pathDirs: ReadonlyArray<string>;
  readonly exists: (path: string) => boolean;
}

interface EditorApp {
  readonly id: EditorId;
  readonly label: string;
  /** The bundle's name under an Applications folder. */
  readonly bundle: string;
  /** The CLI inside the bundle, relative to it. */
  readonly bundleCli: string;
  /** The CLI's name on `PATH`. */
  readonly pathCli: string;
  readonly lineStyle: LineStyle;
}

/** The editors in the order a picker lists them. */
const EDITOR_APPS: ReadonlyArray<EditorApp> = [
  {
    id: "vscode",
    label: "VS Code",
    bundle: "Visual Studio Code.app",
    bundleCli: "Contents/Resources/app/bin/code",
    pathCli: "code",
    lineStyle: "goto",
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    bundle: "Visual Studio Code - Insiders.app",
    bundleCli: "Contents/Resources/app/bin/code-insiders",
    pathCli: "code-insiders",
    lineStyle: "goto",
  },
  {
    id: "cursor",
    label: "Cursor",
    bundle: "Cursor.app",
    bundleCli: "Contents/Resources/app/bin/cursor",
    pathCli: "cursor",
    lineStyle: "goto",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    bundle: "Windsurf.app",
    bundleCli: "Contents/Resources/app/bin/windsurf",
    pathCli: "windsurf",
    lineStyle: "goto",
  },
  {
    id: "zed",
    label: "Zed",
    bundle: "Zed.app",
    bundleCli: "Contents/MacOS/cli",
    pathCli: "zed",
    lineStyle: "suffix",
  },
  {
    id: "sublime",
    label: "Sublime Text",
    bundle: "Sublime Text.app",
    bundleCli: "Contents/SharedSupport/bin/subl",
    pathCli: "subl",
    lineStyle: "suffix",
  },
];

/** What a picker calls an app, including one this machine does not have. */
export const editorLabel = (id: EditorId, platform: NodeJS.Platform): string => {
  if (id === "finder") {
    return platform === "darwin" ? "Finder" : platform === "win32" ? "Explorer" : "File manager";
  }
  if (id === "terminal") return "Terminal";
  return EDITOR_APPS.find((app) => app.id === id)?.label ?? id;
};

/** `name` in the first `PATH` directory that has it. */
const onPath = (input: DetectInput, name: string): string | undefined => {
  for (const dir of input.pathDirs) {
    if (dir.length === 0 || !nodePath.isAbsolute(dir)) continue;
    const candidate = nodePath.join(dir, name);
    if (input.exists(candidate)) return candidate;
  }
  return undefined;
};

const macEditor = (input: DetectInput, app: EditorApp): EditorRecipe | null => {
  const bundlePath = ["/Applications", nodePath.join(input.home, "Applications")]
    .map((folder) => nodePath.join(folder, app.bundle))
    .find((path) => input.exists(path));
  const bundleCli = bundlePath === undefined ? undefined : nodePath.join(bundlePath, app.bundleCli);
  const cli =
    bundleCli !== undefined && input.exists(bundleCli) ? bundleCli : onPath(input, app.pathCli);
  if (bundlePath === undefined && cli === undefined) return null;
  return {
    id: app.id,
    label: app.label,
    kind: "editor",
    cli,
    bundlePath,
    lineStyle: app.lineStyle,
  };
};

/** Every app this machine has, editors first, then the file manager and terminal. */
export const detectEditors = (input: DetectInput): ReadonlyArray<EditorRecipe> => {
  const found: Array<EditorRecipe> = [];
  const finder = (cli?: string): EditorRecipe => ({
    id: "finder",
    label: editorLabel("finder", input.platform),
    kind: "file-manager",
    cli,
  });
  switch (input.platform) {
    case "darwin": {
      for (const app of EDITOR_APPS) {
        const recipe = macEditor(input, app);
        if (recipe !== null) found.push(recipe);
      }
      found.push(finder(), { id: "terminal", label: "Terminal", kind: "terminal" });
      return found;
    }
    case "linux": {
      for (const app of EDITOR_APPS) {
        const cli = onPath(input, app.pathCli);
        if (cli === undefined) continue;
        found.push({ id: app.id, label: app.label, kind: "editor", cli, lineStyle: app.lineStyle });
      }
      const xdgOpen = onPath(input, "xdg-open");
      if (xdgOpen !== undefined) found.push(finder(xdgOpen));
      return found;
    }
    case "win32":
      return [finder()];
    default:
      return [];
  }
};

/** What the wire carries about a recipe: a line needs a CLI to pass it to. */
export const toDetectedEditor = (recipe: EditorRecipe): DetectedEditor => ({
  id: recipe.id,
  label: recipe.label,
  kind: recipe.kind,
  supportsLine: recipe.kind === "editor" && recipe.cli !== undefined,
});

/**
 * What a file's menu offers, in order — the Changes "…" menu, the right-click
 * menu on a Changes file header and the one on a Files row all list the same
 * entries (`./file-menu-items` renders them either way).
 *
 * The entries come in groups, and a renderer puts a separator between two
 * groups: showing the file (in the Files tab, the favourite editor, another
 * detected editor), revealing it in the file manager, copying its path, and
 * adding it to the chat. Anything the menu cannot do here is left out rather
 * than disabled: no editor detected means no "Open in" or "Open with", an
 * unknown workspace root means no absolute path to copy, a directory has no
 * Files-tab preview, a file no longer on disk (deleted in Changes) can only
 * be copied or added to the chat, and a Changes file outside the workspace
 * (a project in a subfolder of its repository) keeps only its relative path
 * and the chat.
 */

import type { DetectedEditor } from "@poseidon/contracts/editors";

import { absolutePath, editorsOnly } from "./favourite";

export type FileMenuEntry =
  /** Show the file in the dock's Files tab; `label` differs in the tab itself. */
  | { readonly kind: "files-tab"; readonly label: string }
  | { readonly kind: "open"; readonly editor: DetectedEditor }
  | { readonly kind: "open-with"; readonly editors: ReadonlyArray<DetectedEditor> }
  | { readonly kind: "reveal"; readonly app: DetectedEditor }
  | { readonly kind: "copy"; readonly label: string; readonly text: string }
  | { readonly kind: "add-to-chat" };

export interface FileMenuInput {
  /** Relative to the workspace root, as the server lists it, when `inWorkspace`. */
  readonly path: string;
  /** `false` for a Changes path outside the root, relative to the repository instead. */
  readonly inWorkspace: boolean;
  readonly isDirectory: boolean;
  /** Whether the file is on disk; a deleted one cannot be opened or revealed. */
  readonly exists: boolean;
  /** The workspace root the path is under, or `null` when it is not known. */
  readonly root: string | null;
  /** Every app the server detected, editors first. */
  readonly editors: ReadonlyArray<DetectedEditor>;
  readonly favourite: DetectedEditor | null;
  /**
   * How the Files tab is offered: `reveal` from elsewhere ("Open in Files
   * tab"), `open` inside the tab itself, `null` where no thread answers it.
   */
  readonly filesTab: "reveal" | "open" | null;
  /** A thread or draft to add the path to. */
  readonly canAddToChat: boolean;
}

export const fileMenuEntries = (
  input: FileMenuInput,
): ReadonlyArray<ReadonlyArray<FileMenuEntry>> => {
  const { path, root, favourite } = input;
  // Opening goes through the server, which resolves the path under the root.
  const openable = input.exists && input.inWorkspace;
  const editors = editorsOnly(input.editors);
  const fileManager = input.editors.find((app) => app.kind === "file-manager");

  const show: Array<FileMenuEntry> = [];
  if (input.filesTab !== null && !input.isDirectory && openable) {
    show.push({
      kind: "files-tab",
      label: input.filesTab === "open" ? "Open" : "Open in Files tab",
    });
  }
  if (openable && favourite !== null) show.push({ kind: "open", editor: favourite });
  if (openable && editors.length > 0) show.push({ kind: "open-with", editors });

  const reveal: Array<FileMenuEntry> =
    fileManager === undefined || !openable ? [] : [{ kind: "reveal", app: fileManager }];

  const copy: Array<FileMenuEntry> = [
    ...(root === null || !input.inWorkspace
      ? []
      : [{ kind: "copy", label: "Copy path", text: absolutePath(root, path) } as const]),
    { kind: "copy", label: "Copy relative path", text: path },
  ];

  const chat: Array<FileMenuEntry> = input.canAddToChat ? [{ kind: "add-to-chat" }] : [];

  return [show, reveal, copy, chat].filter((group) => group.length > 0);
};

/**
 * A Changes path — relative to the repository's top level, as git prints it
 * — relative to the workspace root instead, which sits `prefix` deep in the
 * repository (`GitDiff.prefix`: `""` at the top level, else ending in `/`);
 * `null` for a file outside the workspace.
 */
export const workspacePath = (repoPath: string, prefix: string): string | null =>
  repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null;

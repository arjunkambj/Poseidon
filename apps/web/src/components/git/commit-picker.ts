/**
 * The pure half of the commit dialog: which files are ticked, the message the
 * commit gets, the buttons' labels and why they are off, and the key that
 * submits.
 *
 * The picker keeps the *unticked* paths, not the ticked ones, so every file
 * starts ticked and a file that appears while the dialog is open (the control
 * refetches the status as it opens) starts ticked like the rest. The message
 * follows the draft for the ticked files (`commitSelection`) until the user
 * types; from the first keystroke their text wins and nothing replaces it.
 *
 * A generated message (`fillGenerated`) counts as edited too: it stops
 * following the draft. It is marked `generated` until the user changes it,
 * and a commit made with it unchanged says so in its choice, which is what
 * lets a pull request in the same run be generated as well.
 */

import type { ModKey } from "@poseidon/client-runtime/keybindings";
import type { GitFileChange } from "@poseidon/contracts/rpc";

import { commitSelection, type GitAction } from "@/lib/git-actions";

/**
 * What the dialog commits: `paths` is absent when every file is ticked.
 * `generated` is true when the message was generated and not edited after.
 */
export interface CommitChoice {
  readonly message: string;
  readonly paths?: ReadonlyArray<string>;
  readonly generated: boolean;
}

export interface CommitPickerState {
  /** The paths the user unticked. */
  readonly excluded: ReadonlySet<string>;
  /** The user's message; `null` until they type, while it follows the draft. */
  readonly edited: string | null;
  /** Whether `edited` is a generated message the user has not changed since. */
  readonly generated: boolean;
}

export const initialPicker = (): CommitPickerState => ({
  excluded: new Set(),
  edited: null,
  generated: false,
});

export const togglePath = (
  state: CommitPickerState,
  path: string,
  ticked: boolean,
): CommitPickerState => {
  const excluded = new Set(state.excluded);
  if (ticked) {
    excluded.delete(path);
  } else {
    excluded.add(path);
  }
  return { ...state, excluded };
};

export const toggleAll = (
  state: CommitPickerState,
  files: ReadonlyArray<GitFileChange>,
  ticked: boolean,
): CommitPickerState => ({
  ...state,
  excluded: ticked ? new Set() : new Set(files.map((file) => file.path)),
});

export const editMessage = (state: CommitPickerState, message: string): CommitPickerState => ({
  ...state,
  edited: message,
  generated: false,
});

/** The message box's text for a generated subject and body. */
export const generatedCommitMessage = (generated: {
  readonly subject: string;
  readonly body: string;
}): string => {
  const body = generated.body.trim();
  return body === "" ? generated.subject.trim() : `${generated.subject.trim()}\n\n${body}`;
};

/** Puts a generated message in the box: edited, like typing, and marked generated. */
export const fillGenerated = (state: CommitPickerState, message: string): CommitPickerState => ({
  ...editMessage(state, message),
  generated: true,
});

/** The message in the box, the ticked count, and what a submit sends. */
export const commitPick = (
  state: CommitPickerState,
  title: string,
  files: ReadonlyArray<GitFileChange>,
): { readonly message: string; readonly ticked: number; readonly choice: CommitChoice } => {
  const selection = commitSelection(title, files, state.excluded);
  const message = state.edited ?? selection.message;
  return {
    message,
    ticked: selection.included.length,
    choice: {
      message: message.trim(),
      ...(selection.paths === undefined ? {} : { paths: selection.paths }),
      generated: state.edited !== null && state.generated,
    },
  };
};

const STATUS_LETTER: Record<GitFileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

export const statusLetter = (status: GitFileChange["status"]): string => STATUS_LETTER[status];

/**
 * `path` in at most `max` characters: the file name kept whole and the middle
 * of the directories elided with `…`. A file name too long on its own keeps
 * its end.
 */
export const middleTruncate = (path: string, max: number): string => {
  if (path.length <= max) {
    return path;
  }
  const slash = path.lastIndexOf("/");
  const tail = slash === -1 ? path : path.slice(slash);
  const head = max - 1 - tail.length;
  return head <= 0 ? `…${path.slice(path.length - (max - 1))}` : `${path.slice(0, head)}…${tail}`;
};

const ACTION_SUFFIX: Record<GitAction, string> = {
  commit: "",
  "commit-push": " & push",
  "commit-push-pr": " & create PR",
};

/** `Commit 3 files`, `Commit 1 file & push`, `Commit 2 files & create PR`. */
export const commitButtonLabel = (action: GitAction, count: number): string =>
  `Commit ${count} ${count === 1 ? "file" : "files"}${ACTION_SUFFIX[action]}`;

/** Why no button can commit what the picker holds; `null` when it can. */
export const commitBlockedReason = (input: {
  readonly ticked: number;
  readonly message: string;
}): string | null =>
  input.ticked === 0
    ? "Tick at least one file to commit."
    : input.message.trim() === ""
      ? "Write a commit message."
      : null;

export type SelectAllState = "checked" | "unchecked" | "indeterminate";

/** The select-all box: ticked when every file is, empty when none is, else mixed. */
export const selectAllState = (ticked: number, total: number): SelectAllState =>
  ticked === 0 ? "unchecked" : ticked >= total ? "checked" : "indeterminate";

/** Mod+Enter — Meta on macOS, Ctrl elsewhere — with no other modifier. */
export const isSubmitChord = (
  event: {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
  },
  modKey: ModKey,
): boolean =>
  event.key === "Enter" &&
  !event.altKey &&
  !event.shiftKey &&
  (modKey === "meta" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

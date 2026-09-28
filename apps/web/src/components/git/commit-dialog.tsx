/**
 * The commit dialog the git actions control opens before any action that
 * commits: the message, the files to include, and one button per action —
 * Commit, Commit & push, and Commit & create PR. The X in the corner (or
 * Escape) aborts.
 *
 * The message box opens with `commitMessageDraft` — the thread's title and
 * the ticked paths — and follows it as files are ticked and unticked, and as
 * the refetched status lands, until the user types; then it is theirs
 * (`./commit-picker`). The file list (`./commit-file-list`) starts with every
 * file ticked. The same pick drives all three buttons, each labelled with the
 * count (`Commit 3 files & push`); `paths` is sent only when something is
 * unticked, so with everything ticked the server stages everything
 * (`git add -A`), which a commit in the middle of a merge needs.
 *
 * The action the dialog was opened for — the header's button or a key — is
 * the filled button and has the focus, so Enter runs it; the others are
 * outlined. Mod+Enter runs it from anywhere in the dialog, the message box
 * included; that key is the dialog's own, not a keymap default. A button that
 * cannot run is disabled, and its tooltip says why: nothing ticked, an empty
 * message, or the action's own reason (`reasons`, from the control's
 * `availableActions`).
 *
 * The control mounts a fresh dialog (a new `key`) for each opening, so each
 * opening starts from the draft with every file ticked. The dialog scrolls on
 * a short window.
 */

import * as React from "react";

import { detectModKey } from "@poseidon/client-runtime/keybindings";
import { Button } from "@poseidon/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";
import { Label } from "@poseidon/ui/components/label";
import { Textarea } from "@poseidon/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { GitFileChange } from "@poseidon/contracts/rpc";

import { DialogActions } from "@/components/dialog-actions";
import { DialogBody } from "@/components/dialog-body";
import { GIT_ACTIONS, type GitAction } from "@/lib/git-actions";

import { CommitFileList } from "./commit-file-list";
import {
  commitBlockedReason,
  commitButtonLabel,
  commitPick,
  editMessage,
  initialPicker,
  isSubmitChord,
  toggleAll,
  togglePath,
  type CommitChoice,
  type CommitPickerState,
} from "./commit-picker";

interface CommitDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The action the dialog was opened for: the filled, focused button. */
  readonly initialAction: GitAction;
  /** Why each action cannot run; `null` when it can. */
  readonly reasons: Readonly<Record<GitAction, string | null>>;
  /** The thread's title, the subject of the drafted message. */
  readonly threadTitle: string;
  readonly branch: string | null;
  readonly files: ReadonlyArray<GitFileChange>;
  readonly onSubmit: (action: GitAction, choice: CommitChoice) => void;
}

export function CommitDialog(props: CommitDialogProps) {
  const [picker, setPicker] = React.useState(initialPicker);
  return <CommitDialogView {...props} picker={picker} onPickerChange={setPicker} />;
}

/** The dialog with its pick held by the caller — `CommitDialog` holds it in state. */
export function CommitDialogView({
  open,
  onOpenChange,
  initialAction,
  reasons,
  threadTitle,
  branch,
  files,
  onSubmit,
  picker,
  onPickerChange,
}: CommitDialogProps & {
  readonly picker: CommitPickerState;
  readonly onPickerChange: (picker: CommitPickerState) => void;
}) {
  const primary = React.useRef<HTMLButtonElement>(null);
  const { message, ticked, choice } = commitPick(picker, threadTitle, files);
  const blocked = commitBlockedReason({ ticked, message });
  const reasonFor = (action: GitAction) => blocked ?? reasons[action];

  const submit = (action: GitAction) => {
    if (reasonFor(action) !== null) {
      return;
    }
    onOpenChange(false);
    onSubmit(action, choice);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        initialFocus={primary}
        onKeyDown={(event) => {
          if (isSubmitChord(event, detectModKey())) {
            event.preventDefault();
            submit(initialAction);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Commit changes</DialogTitle>
          <DialogDescription>
            {`Commits on ${branch ?? "a detached HEAD"}, with your own git identity and hooks.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="commit-message">Message</Label>
            <Textarea
              id="commit-message"
              value={message}
              rows={5}
              spellCheck
              className="max-h-48 overflow-y-auto"
              onChange={(event) => onPickerChange(editMessage(picker, event.target.value))}
            />
          </div>
          <CommitFileList
            files={files}
            excluded={picker.excluded}
            onToggle={(path, tick) => onPickerChange(togglePath(picker, path, tick))}
            onToggleAll={(tick) => onPickerChange(toggleAll(picker, files, tick))}
          />
        </DialogBody>
        <DialogActions>
          {GIT_ACTIONS.map((action) => {
            const reason = reasonFor(action);
            const button = (
              <Button
                ref={action === initialAction ? primary : undefined}
                type="button"
                variant={action === initialAction ? "default" : "outline"}
                disabled={reason !== null}
                onClick={() => submit(action)}
              >
                {commitButtonLabel(action, ticked)}
              </Button>
            );
            return reason === null ? (
              <React.Fragment key={action}>{button}</React.Fragment>
            ) : (
              <Tooltip key={action}>
                <TooltipTrigger render={<span className="inline-flex *:w-full" />}>
                  {button}
                </TooltipTrigger>
                <TooltipContent>{reason}</TooltipContent>
              </Tooltip>
            );
          })}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

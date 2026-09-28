/**
 * The Pull request tab's comment actions, bound to its thread.
 *
 * "Add to chat" appends the quote to the thread's message the way the Files
 * and Changes menus add a path (`@/components/open-in/file-menu-items`): the
 * person reads it and sends it; nothing reaches the agent on its own.
 *
 * "Open in Changes" switches the Changes tab to Branch vs base — a choice
 * remembered for every thread, as picking it there is — and links to the
 * comment's file and line through the pane's own deep link
 * (`?pane=changes&file=&line=`), which opens that file, marks the line in its
 * diff and centres it. A comment on the whole file links to the file alone.
 */

import type { ThreadId } from "@poseidon/contracts/ids";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import { appendToDraft } from "@/components/panes/browser/page-to-chat";
import { useKeybindingDispatch } from "@/lib/shortcuts";
import { useChangesScope, useComposerDraft } from "@/state/ui";

import type { CommentActions } from "./pr-comment";

export const useCommentActions = (threadId: ThreadId): CommentActions => {
  const { setText } = useComposerDraft(threadId);
  const dispatch = useKeybindingDispatch();
  const navigate = useNavigate();
  const [, setChangesScope] = useChangesScope();
  return React.useMemo(
    () => ({
      onAddToChat: (text: string) => {
        setText((current) => appendToDraft(current, text));
        toast.success("Added the comment to your message");
        dispatch("composer.focus");
      },
      onOpenInChanges: (path: string, line: number | null) => {
        setChangesScope("branch");
        void navigate({
          to: "/t/$threadId",
          params: { threadId },
          search: (previous) => ({
            ...previous,
            pane: "changes",
            turn: undefined,
            file: path,
            line: line ?? undefined,
          }),
          replace: true,
        });
      },
    }),
    [setText, dispatch, navigate, setChangesScope, threadId],
  );
};

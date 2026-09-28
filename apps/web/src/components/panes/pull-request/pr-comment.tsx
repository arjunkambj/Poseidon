/**
 * One comment in the Pull request tab — a review comment, a review's summary
 * or a conversation comment: who wrote it, when, its markdown body, and the
 * row's icon buttons. "Add to chat" puts a quote of it in the thread's
 * message for the person to send; "Open in Changes" (review comments only)
 * shows the file it is on.
 */

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type * as React from "react";

import { MarkdownBody } from "@/components/timeline/markdown";
import { relativeTime } from "@/lib/format";

import { Chat, GitDiff } from "@honeyicons/react";

import { visibleBody } from "./pr-format";

/** What the tab's rows can do with a comment; the pane binds them to the thread. */
export interface CommentActions {
  /** Append `text` to the thread's message and focus the composer. */
  readonly onAddToChat: (text: string) => void;
  /** Open the Changes tab on the branch's diff at `path`. */
  readonly onOpenInChanges: (path: string) => void;
}

function IconAction({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function AddToChatAction({ onClick }: { readonly onClick: () => void }) {
  return (
    <IconAction label="Add to chat" onClick={onClick}>
      <Chat variant="bold" />
    </IconAction>
  );
}

export function OpenInChangesAction({ onClick }: { readonly onClick: () => void }) {
  return (
    <IconAction label="Open in Changes" onClick={onClick}>
      <GitDiff variant="bold" />
    </IconAction>
  );
}

export function PrComment({
  author,
  at,
  body,
  nowMs,
  badge,
  onAddToChat,
}: {
  readonly author: string;
  readonly at: string | null;
  readonly body: string;
  readonly nowMs: number;
  /** A word after the author: a review's verdict. */
  readonly badge?: React.ReactNode;
  readonly onAddToChat: (() => void) | null;
}) {
  const when = at === null ? "" : relativeTime(nowMs, at);
  const shown = visibleBody(body);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex h-7 items-center gap-2 text-xs">
        <span className="min-w-0 truncate font-medium text-foreground">@{author}</span>
        {badge}
        {when === "" ? null : <span className="shrink-0 text-muted-foreground">{when}</span>}
        <span className="ml-auto flex shrink-0 items-center">
          {onAddToChat === null ? null : <AddToChatAction onClick={onAddToChat} />}
        </span>
      </div>
      {shown === "" ? null : (
        <MarkdownBody text={shown} variant="user" className="text-xs break-words" />
      )}
    </div>
  );
}

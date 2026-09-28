/**
 * The Pull request tab's Fix menu: each fix that applies now (`fixKinds`)
 * starts a new thread on the same branch, seeded with what it needs to fix.
 * Picking one opens a confirm naming where the thread goes and a preview of
 * its first message — built from the view, so the log tails and conflicting
 * files it will carry are read only once the person confirms. Nothing shows
 * when no fix applies.
 */

import { Button } from "@poseidon/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import type { PullRequestDetail } from "@poseidon/contracts/pullRequest";
import * as React from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";

import { Hammer } from "@honeyicons/react";

import { buildFixPrompt, FIX_LABELS, fixKinds, previewText, type FixKind } from "./pr-fix-prompt";

const FIX_NOTES: Record<FixKind, string> = {
  checks: "The failed logs of up to three GitHub Actions jobs are read when it starts.",
  conflicts: "The conflicting files are read, as of the last fetch, when it starts.",
  reviews: "",
};

export interface PrFixMenuViewProps {
  readonly pullRequest: PullRequestDetail;
  /** Where the new thread works: "the worktree at …" or "the project's folder". */
  readonly target: string;
  readonly confirming: FixKind | null;
  readonly onConfirming: (kind: FixKind | null) => void;
  readonly onFix: (kind: FixKind) => void;
}

export function PrFixMenuView({
  pullRequest,
  target,
  confirming,
  onConfirming,
  onFix,
}: PrFixMenuViewProps) {
  const kinds = fixKinds(pullRequest);
  if (kinds.length === 0) {
    return null;
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" />}>
          <Hammer variant="bold" />
          Fix
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {kinds.map((kind) => (
            <DropdownMenuItem key={kind} onClick={() => onConfirming(kind)}>
              {FIX_LABELS[kind]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            onConfirming(null);
          }
        }}
        title={confirming === null ? "" : `${FIX_LABELS[confirming]} in a new thread?`}
        description={`A new thread starts on ${pullRequest.headRefName} in ${target}, with this as its first message.`}
        confirmLabel="Start thread"
        onConfirm={() => {
          if (confirming !== null) {
            onFix(confirming);
          }
        }}
      >
        {confirming === null ? null : (
          <div className="flex min-w-0 flex-col gap-1.5">
            <pre className="max-h-48 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground wrap-anywhere">
              {previewText(buildFixPrompt(confirming, pullRequest, null))}
            </pre>
            {FIX_NOTES[confirming] === "" ? null : (
              <p className="text-xs text-muted-foreground">{FIX_NOTES[confirming]}</p>
            )}
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}

export function PrFixMenu({
  pullRequest,
  target,
  onFix,
}: Pick<PrFixMenuViewProps, "pullRequest" | "target" | "onFix">) {
  const [confirming, setConfirming] = React.useState<FixKind | null>(null);
  return (
    <PrFixMenuView
      pullRequest={pullRequest}
      target={target}
      confirming={confirming}
      onConfirming={setConfirming}
      onFix={onFix}
    />
  );
}

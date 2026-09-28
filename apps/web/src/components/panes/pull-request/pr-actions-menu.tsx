/**
 * The Pull request tab's lifecycle control, in the summary: the first action
 * the pull request offers as a button, the rest behind a "…" menu (a blocked
 * one listed disabled with its reason). Every action opens one confirm; Merge's
 * carries the method picker — the repository's allowed methods, squash first
 * when allowed — and a warning line while checks fail. The run and its toasts
 * are the caller's (`onRun`, `runPrAction`).
 *
 * `PrActionsMenuView` is the controlled half, rendered by the tests with the
 * confirm already open.
 */

import { Button } from "@poseidon/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@poseidon/ui/components/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { PullRequestDetail } from "@poseidon/contracts/pullRequest";
import * as React from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";

import { AlertTriangle, MoreHorizontal } from "@honeyicons/react";

import {
  allowedMergeMethods,
  MERGE_METHOD_LABELS,
  mergeWarning,
  prActionCopy,
  prActions,
  type MergeMethod,
  type PrActionKind,
} from "./pr-actions";

export interface PrActionsMenuViewProps {
  readonly pullRequest: PullRequestDetail;
  /** The action whose confirm is open. */
  readonly confirming: PrActionKind | null;
  readonly onConfirming: (kind: PrActionKind | null) => void;
  readonly method: MergeMethod;
  readonly onMethod: (method: MergeMethod) => void;
  readonly onConfirm: (kind: PrActionKind, method: MergeMethod) => void;
}

function MergeOptions({
  pullRequest,
  method,
  onMethod,
}: Pick<PrActionsMenuViewProps, "pullRequest" | "method" | "onMethod">) {
  const methods = allowedMergeMethods(pullRequest);
  const warning = mergeWarning(pullRequest);
  return (
    <div className="flex flex-col gap-2">
      <Select
        value={method}
        onValueChange={(next) => {
          if (next !== null) {
            onMethod(next);
          }
        }}
      >
        <SelectTrigger className="w-full" aria-label="Merge method">
          <SelectValue>{(value: MergeMethod) => MERGE_METHOD_LABELS[value]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {methods.map((option) => (
            <SelectItem key={option} value={option}>
              {MERGE_METHOD_LABELS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {warning === null ? null : (
        <p className="flex items-center gap-1.5 text-xs text-permission">
          <AlertTriangle variant="bold" className="size-3.5" />
          {warning}
        </p>
      )}
    </div>
  );
}

export function PrActionsMenuView({
  pullRequest,
  confirming,
  onConfirming,
  method,
  onMethod,
  onConfirm,
}: PrActionsMenuViewProps) {
  const offers = prActions(pullRequest);
  const primary = offers.find((offer) => offer.disabledReason === null);
  const rest = offers.filter((offer) => offer !== primary);
  if (offers.length === 0) {
    return null;
  }
  const copy = confirming === null ? null : prActionCopy(confirming, pullRequest);
  return (
    <div className="flex items-center gap-1">
      {primary === undefined ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onConfirming(primary.kind)}
        >
          {prActionCopy(primary.kind, pullRequest).label}
        </Button>
      )}
      {rest.length === 0 ? null : (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="More pull request actions"
                    />
                  }
                />
              }
            >
              <MoreHorizontal variant="bold" />
            </TooltipTrigger>
            <TooltipContent>More actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-64">
            {rest.map((offer) => (
              <DropdownMenuItem
                key={offer.kind}
                disabled={offer.disabledReason !== null}
                variant={offer.kind === "close" ? "destructive" : "default"}
                onClick={() => onConfirming(offer.kind)}
              >
                <span className="flex min-w-0 flex-col">
                  <span>{prActionCopy(offer.kind, pullRequest).label}</span>
                  {offer.disabledReason === null ? null : (
                    <span className="text-xs whitespace-normal text-muted-foreground">
                      {offer.disabledReason}
                    </span>
                  )}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            onConfirming(null);
          }
        }}
        title={copy?.title ?? ""}
        description={copy?.description ?? ""}
        confirmLabel={copy?.confirm ?? ""}
        onConfirm={() => {
          if (confirming !== null) {
            onConfirm(confirming, method);
          }
        }}
      >
        {confirming === "merge" ? (
          <MergeOptions pullRequest={pullRequest} method={method} onMethod={onMethod} />
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

/** The control with its own state: which confirm is open and the merge method picked. */
export function PrActionsMenu({
  pullRequest,
  onRun,
}: {
  readonly pullRequest: PullRequestDetail;
  readonly onRun: (kind: PrActionKind, method: MergeMethod) => void;
}) {
  const [confirming, setConfirming] = React.useState<PrActionKind | null>(null);
  const methods = allowedMergeMethods(pullRequest);
  const [picked, setPicked] = React.useState<MergeMethod | null>(null);
  // A method the repository no longer allows falls back to the first it does.
  const method = picked !== null && methods.includes(picked) ? picked : (methods[0] ?? "squash");
  return (
    <PrActionsMenuView
      pullRequest={pullRequest}
      confirming={confirming}
      onConfirming={setConfirming}
      method={method}
      onMethod={setPicked}
      onConfirm={onRun}
    />
  );
}

/**
 * The Pull request tab's head: the title, its number as a link to GitHub,
 * its state, where it merges (base ← head), who opened it and when it last
 * changed. The refresh button sits beside the title, and the lifecycle
 * actions and the Fix menu (`./pr-controls`) under the author line.
 */

import { Badge } from "@poseidon/ui/components/badge";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { PullRequestDetail } from "@poseidon/contracts/pullRequest";
import type * as React from "react";

import { openExternal } from "@/lib/desktop";

import { ExternalLink, Refresh } from "@honeyicons/react";

import { updatedLabel } from "./pr-format";

/** The state as a word and a badge look: draft is a state of its own while open. */
const stateBadge = (
  pullRequest: Pick<PullRequestDetail, "state" | "isDraft">,
): { readonly label: string; readonly variant: "secondary" | "outline" | "destructive" } => {
  if (pullRequest.state === "merged") {
    return { label: "Merged", variant: "secondary" };
  }
  if (pullRequest.state === "closed") {
    return { label: "Closed", variant: "destructive" };
  }
  return pullRequest.isDraft
    ? { label: "Draft", variant: "outline" }
    : { label: "Open", variant: "secondary" };
};

export function PrSummary({
  pullRequest,
  nowMs,
  onRefresh,
  controls,
}: {
  readonly pullRequest: PullRequestDetail;
  readonly nowMs: number;
  readonly onRefresh: () => void;
  /** The lifecycle actions and the Fix menu, under the author line. */
  readonly controls?: React.ReactNode;
}) {
  const badge = stateBadge(pullRequest);
  const updated = updatedLabel(nowMs, pullRequest.updatedAt);
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-sm leading-snug font-medium text-foreground">
          {pullRequest.title}
        </h2>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Refresh pull request"
                onClick={onRefresh}
              />
            }
          >
            <Refresh variant="bold" />
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <Button
          type="button"
          variant="link"
          size="xs"
          aria-label={`Open pull request #${pullRequest.number} on GitHub`}
          onClick={() => openExternal(pullRequest.url)}
        >
          #{pullRequest.number}
          <ExternalLink variant="bold" />
        </Button>
        <span className="min-w-0 truncate font-mono">
          {pullRequest.baseRefName} ← {pullRequest.headRefName}
        </span>
      </div>
      <div className="text-xs text-muted-foreground">
        @{pullRequest.author}
        {updated === "" ? null : ` · ${updated}`}
      </div>
      {controls}
    </div>
  );
}

/**
 * The Pull request tab's head: the title, its number as a link to GitHub,
 * its state (tinted as the sidebar's glyph is), where it merges (base ← head), who opened it and when it last
 * changed. The refresh button sits beside the title, and the lifecycle
 * actions and the Fix menu (`./pr-controls`) under the author line.
 */

import { Badge } from "@poseidon/ui/components/badge";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { PullRequestDetail } from "@poseidon/contracts/pullRequest";
import type * as React from "react";

import { openExternal } from "@/lib/desktop";
import { pullRequestTone } from "@/lib/pull-request-tone";

import { ExternalLink, Refresh } from "@honeyicons/react";

import { updatedLabel } from "./pr-format";

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
  // The glyph the sidebar row shows for this pull request, in its tint.
  const tone = pullRequestTone({
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    failing: pullRequest.checks.some((check) => check.bucket === "fail"),
  });
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
        <Badge variant="outline">
          <tone.icon variant="bold" className={tone.tone} />
          {tone.state}
        </Badge>
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

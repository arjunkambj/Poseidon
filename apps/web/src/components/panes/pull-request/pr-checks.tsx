/**
 * The Pull request tab's checks: a count line, then one 28px row per check —
 * its bucket's icon, name, workflow, how long it ran and a link to its log on
 * GitHub. The server already orders them failing first, then pending,
 * passing and skipped.
 */

import type { HoneyIcon } from "@honeyicons/react";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { PullRequestCheck } from "@poseidon/contracts/pullRequest";

import { openExternal } from "@/lib/desktop";
import { cn } from "@/lib/utils";

import { Check, Clock, Close, ExternalLink, Minus } from "@honeyicons/react";

import { checkDuration, checkSummary } from "./pr-format";

const BUCKET_ICON: Record<
  PullRequestCheck["bucket"],
  { readonly icon: HoneyIcon; readonly tone: string; readonly label: string }
> = {
  fail: { icon: Close, tone: "text-destructive", label: "Failing" },
  pending: { icon: Clock, tone: "text-muted-foreground", label: "Pending" },
  pass: { icon: Check, tone: "text-added", label: "Passing" },
  skipped: { icon: Minus, tone: "text-muted-foreground", label: "Skipped" },
};

function CheckRow({ check }: { readonly check: PullRequestCheck }) {
  const bucket = BUCKET_ICON[check.bucket];
  const Icon = bucket.icon;
  const duration = checkDuration(check);
  const url = check.url;
  return (
    <li className="flex h-7 items-center gap-2 px-3 text-xs">
      <Icon
        variant="bold"
        aria-label={bucket.label}
        className={cn("size-3.5 shrink-0", bucket.tone)}
      />
      <span className="min-w-0 truncate text-foreground">{check.name}</span>
      {check.workflow === null ? null : (
        <span className="min-w-0 shrink truncate text-muted-foreground">{check.workflow}</span>
      )}
      <span className="ml-auto shrink-0 font-mono text-muted-foreground tabular-nums">
        {duration}
      </span>
      {url === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Open the log of ${check.name}`}
                onClick={() => openExternal(url)}
              />
            }
          >
            <ExternalLink variant="bold" />
          </TooltipTrigger>
          <TooltipContent>Open log</TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}

export function PrChecks({ checks }: { readonly checks: ReadonlyArray<PullRequestCheck> }) {
  return (
    <section aria-label="Checks" className="flex flex-col">
      <h3 className="flex h-7 items-center gap-2 px-3 text-xs font-medium text-muted-foreground">
        Checks
        <span className="font-normal">{checkSummary(checks)}</span>
      </h3>
      {checks.length === 0 ? null : (
        <ul className="flex flex-col">
          {checks.map((check, index) => (
            <CheckRow key={`${check.workflow ?? ""}/${check.name}/${index}`} check={check} />
          ))}
        </ul>
      )}
    </section>
  );
}

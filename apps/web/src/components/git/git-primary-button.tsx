/**
 * The git actions control's buttons: the primary one, which offers the next
 * step for the branch (`nextGitStep`), and a menu beside it with every action.
 *
 * The primary button shows the step's badge — the changed-file count while
 * committing, the commits ahead while pushing — and says in its tooltip what
 * it does, or why it cannot. View PR opens the remembered pull request and
 * runs nothing, so it stays enabled while a turn or a git run is going.
 *
 * The menu lists Commit, Commit & push and Commit & create PR; one that
 * cannot run is disabled with its reason as a second line, since a tooltip
 * inside a menu item is awkward to reach. A known pull request adds View
 * pull request at the bottom.
 *
 * This is presentational: the control decides the step and the reasons, and
 * runs what is picked.
 */

import { Badge } from "@poseidon/ui/components/badge";
import { Button } from "@poseidon/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import {
  ChevronDown,
  CloudUpload,
  ExternalLink,
  GitCommit,
  GitPullRequest,
  Spinner,
} from "@honeyicons/react";

import type { GitAction } from "@/lib/git-actions";
import type { GitNextStep, GitNextStepView } from "@/lib/git-next-step";

const STEP_ICONS: Record<GitNextStep, typeof GitCommit> = {
  commit: GitCommit,
  push: CloudUpload,
  "create-pr": GitPullRequest,
  "view-pr": ExternalLink,
};

const MENU_ACTIONS: ReadonlyArray<{
  readonly action: GitAction;
  readonly label: string;
  readonly icon: typeof GitCommit;
}> = [
  { action: "commit", label: "Commit", icon: GitCommit },
  { action: "commit-push", label: "Commit & push", icon: CloudUpload },
  { action: "commit-push-pr", label: "Commit & create PR", icon: GitPullRequest },
];

/** Why every action is off while a git run is going. */
export const GIT_RUN_PENDING_REASON = "A git action is running.";

export interface GitPrimaryButtonProps {
  readonly next: GitNextStepView;
  /** What the enabled primary button does, for its tooltip. */
  readonly hint: string;
  /** A git run is going: every action is off, View PR stays. */
  readonly pending: boolean;
  readonly pullRequestUrl: string | null;
  /** Why each menu action cannot run; `null` means it can. */
  readonly reasons: Record<GitAction, string | null>;
  readonly onStart: (action: GitAction) => void;
  readonly onOpen: (url: string) => void;
  /** The menu opened: a chance to reread the status it lists reasons from. */
  readonly onMenuOpen?: () => void;
}

export function GitPrimaryButton({
  next,
  hint,
  pending,
  pullRequestUrl,
  reasons,
  onStart,
  onOpen,
  onMenuOpen,
}: GitPrimaryButtonProps) {
  const viewing = next.step === "view-pr";
  const reason = viewing ? null : pending ? GIT_RUN_PENDING_REASON : next.reason;
  const Icon = STEP_ICONS[next.step];

  const click = () => {
    if (viewing) {
      if (pullRequestUrl !== null) onOpen(pullRequestUrl);
    } else if (next.action !== null) {
      onStart(next.action);
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={reason !== null}
            onClick={click}
            aria-label={next.label}
          >
            {pending && !viewing ? <Spinner variant="bold" /> : <Icon variant="bold" />}
            {/* A narrow header keeps the branch name over this label. */}
            <span className="hidden @lg/header:inline">{next.label}</span>
            {next.badge === null ? null : <Badge variant="secondary">{next.badge}</Badge>}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{reason ?? hint}</TooltipContent>
      </Tooltip>

      <DropdownMenu onOpenChange={(open) => open && onMenuOpen?.()}>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label="More git actions" />}
              />
            }
          >
            <ChevronDown variant="bold" />
          </TooltipTrigger>
          <TooltipContent>More git actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-64">
          {MENU_ACTIONS.map(({ action, label, icon: ItemIcon }) => {
            const why = pending ? GIT_RUN_PENDING_REASON : reasons[action];
            return (
              <DropdownMenuItem
                key={action}
                disabled={why !== null}
                onClick={() => onStart(action)}
              >
                <ItemIcon variant="bold" />
                <span className="flex min-w-0 flex-col">
                  <span>{label}</span>
                  {why === null ? null : (
                    <span className="text-xs text-muted-foreground">{why}</span>
                  )}
                </span>
              </DropdownMenuItem>
            );
          })}
          {pullRequestUrl === null ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onOpen(pullRequestUrl)}>
                <ExternalLink variant="bold" />
                View pull request
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

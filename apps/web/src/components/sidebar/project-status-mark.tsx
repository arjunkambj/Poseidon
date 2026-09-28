/**
 * A folded project's status mark on its sidebar header: the icon and tone of
 * its most urgent hidden thread, with a tooltip saying how many threads are in
 * that state — see `./project-status`.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import type { ProjectStatusRollup } from "@/components/sidebar/project-status";

export function ProjectStatusMark({ rollup }: { rollup: ProjectStatusRollup }) {
  const { mark, label } = rollup;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="flex size-4 shrink-0 items-center justify-center"
          />
        }
      >
        <mark.icon variant="bold" className={mark.tone} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

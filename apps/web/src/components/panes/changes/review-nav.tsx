/**
 * The review's navigation buttons in the summary line (`ReviewSummary`): each
 * does what its key does, and its tooltip names that key from the live table.
 */

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { CommandKbd } from "@/lib/shortcuts";

import { type HoneyIcon, Eye } from "@honeyicons/react";

function NavButton({
  label,
  command,
  icon: Icon,
  disabled = false,
  onClick,
}: {
  label: string;
  command: string;
  icon: HoneyIcon;
  disabled?: boolean;
  onClick: () => void;
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
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        <Icon variant="bold" />
      </TooltipTrigger>
      <TooltipContent>
        {label}
        <CommandKbd command={command} />
      </TooltipContent>
    </Tooltip>
  );
}

export function ReviewNav({
  allViewed,
  onNextUnviewed,
}: {
  /** Every file is viewed, so there is no unviewed file to go to. */
  allViewed: boolean;
  onNextUnviewed: () => void;
}) {
  return (
    <NavButton
      label="Next unviewed file"
      command="changes.nextUnviewed"
      icon={Eye}
      disabled={allViewed}
      onClick={onNextUnviewed}
    />
  );
}

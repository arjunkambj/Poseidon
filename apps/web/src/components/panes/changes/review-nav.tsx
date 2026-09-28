/**
 * The review's navigation buttons in the summary line (`ReviewSummary`): each
 * does what its key does, and its tooltip names that key from the live table.
 */

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { CommandKbd } from "@/lib/shortcuts";

import { type HoneyIcon, ChevronDown, ChevronUp, Eye } from "@honeyicons/react";

function NavButton({
  label,
  command,
  icon: Icon,
  disabledReason = null,
  onClick,
}: {
  label: string;
  command: string;
  icon: HoneyIcon;
  /** Why the button does nothing right now, or `null` when it is enabled. */
  disabledReason?: string | null;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      {/* A disabled button takes no pointer events: the wrapper keeps the reason reachable. */}
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabledReason !== null}
          onClick={onClick}
        >
          <Icon variant="bold" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {disabledReason === null ? (
          <>
            {label}
            <CommandKbd command={command} />
          </>
        ) : (
          `${label}: ${disabledReason}`
        )}
      </TooltipContent>
    </Tooltip>
  );
}

const NO_CHANGES = "no changed lines to step through";

export function ReviewNav({
  canStepChange,
  onStepChange,
  allViewed,
  onNextUnviewed,
}: {
  /** Some file has a patch, so there are changes to step through. */
  canStepChange: boolean;
  onStepChange: (direction: 1 | -1) => void;
  /** Every file is viewed, so there is no unviewed file to go to. */
  allViewed: boolean;
  onNextUnviewed: () => void;
}) {
  return (
    <>
      <NavButton
        label="Previous change"
        command="changes.previousChange"
        icon={ChevronUp}
        disabledReason={canStepChange ? null : NO_CHANGES}
        onClick={() => onStepChange(-1)}
      />
      <NavButton
        label="Next change"
        command="changes.nextChange"
        icon={ChevronDown}
        disabledReason={canStepChange ? null : NO_CHANGES}
        onClick={() => onStepChange(1)}
      />
      <NavButton
        label="Next unviewed file"
        command="changes.nextUnviewed"
        icon={Eye}
        disabledReason={allViewed ? "every file is viewed" : null}
        onClick={onNextUnviewed}
      />
    </>
  );
}

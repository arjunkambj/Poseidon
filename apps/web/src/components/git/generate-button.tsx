/**
 * The "Generate" icon button the commit and pull request dialogs set in their
 * text field's corner. Idle, it shows a sparkle and generates; while a run is
 * in flight it shows a spinner and cancels. When nothing can generate it is
 * disabled, and its tooltip says why (`generationBlockedReason`).
 */

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { Sparkles, Spinner } from "@honeyicons/react";

/** What the button shows and does. */
export interface GenerateControl {
  readonly running: boolean;
  /** Why nothing can generate now; `null` when something can. */
  readonly reason: string | null;
  readonly onGenerate: () => void;
  readonly onCancel: () => void;
}

export function GenerateButton({
  label,
  control: { running, reason, onGenerate, onCancel },
}: {
  /** What Generate writes, for its tooltip and label: `Generate message`. */
  readonly label: string;
  readonly control: GenerateControl;
}) {
  const disabled = !running && reason !== null;
  const tip = running ? "Cancel" : (reason ?? label);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={running ? "Cancel generating" : label}
          disabled={disabled}
          onClick={running ? onCancel : onGenerate}
        >
          {running ? (
            <Spinner variant="bold" className="animate-spin" />
          ) : (
            <Sparkles variant="bold" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

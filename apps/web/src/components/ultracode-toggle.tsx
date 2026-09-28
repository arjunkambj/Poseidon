/**
 * The composer's Ultracode toggle, beside Plan mode and styled like it: an
 * icon while off, "Ultracode" while on. It is drawn where the harness and
 * model can run ultracode (`@/lib/ultracode`), and while it is on even where
 * they cannot, so it can always be switched off. It sits inside the
 * `TooltipProvider` of `ThreadSettingsControls` (`./header-controls`).
 */

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";
import { Integration } from "@honeyicons/react";

import { ULTRACODE_OFF_TOOLTIP, ULTRACODE_ON_TOOLTIP, ultracodePatch } from "@/lib/ultracode";

export function UltracodeToggle({
  offered,
  on,
  onChange,
}: {
  readonly offered: boolean;
  readonly on: boolean;
  readonly onChange: (patch: ThreadSettingsPatch) => void;
}) {
  if (!offered && !on) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={on ? "default" : "ghost"}
            tone={on ? "default" : "muted"}
            size={on ? "sm" : "icon-sm"}
            className="shrink-0"
            aria-label="Ultracode"
            aria-pressed={on}
            onClick={() => onChange(ultracodePatch(!on))}
          />
        }
      >
        <Integration variant="bold" data-icon={on ? "inline-start" : undefined} />
        {on ? "Ultracode" : null}
      </TooltipTrigger>
      <TooltipContent>{on ? ULTRACODE_ON_TOOLTIP : ULTRACODE_OFF_TOOLTIP}</TooltipContent>
    </Tooltip>
  );
}

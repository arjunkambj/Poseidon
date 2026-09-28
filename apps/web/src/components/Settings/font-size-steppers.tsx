import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STEP,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type FontSize,
} from "@poseidon/contracts/settings";

import { useFontSizes } from "@/lib/use-font-sizes";
import { Add, Minus } from "@honeyicons/react";

import { SettingsRow, SettingsSection } from "./settings-section";

/** The − / size / + control; `name` is the size's name in the button labels. */
function PxStepper({
  name,
  value,
  onChange,
}: {
  readonly name: string;
  readonly value: FontSize;
  readonly onChange: (next: FontSize) => void;
}) {
  return (
    <div role="group" aria-label={`${name} font size`} className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={`Decrease ${name} font size`}
              disabled={value <= MIN_FONT_SIZE}
              onClick={() => onChange(value - FONT_SIZE_STEP)}
            />
          }
        >
          <Minus variant="bold" />
        </TooltipTrigger>
        <TooltipContent>Smaller</TooltipContent>
      </Tooltip>
      <span aria-live="polite" className="w-16 text-center text-sm tabular-nums">
        {value} px
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={`Increase ${name} font size`}
              disabled={value >= MAX_FONT_SIZE}
              onClick={() => onChange(value + FONT_SIZE_STEP)}
            />
          }
        >
          <Add variant="bold" />
        </TooltipTrigger>
        <TooltipContent>Larger</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * The main and sidebar text sizes, in px. The sidebar size covers the left
 * sidebar and the right dock. The `font.*` keys step both through the same
 * `useFontSizes`, so these read the new value as soon as the settings do.
 */
export function FontSizeSteppers() {
  const { sizes, setSizes } = useFontSizes();
  const main = sizes?.main ?? DEFAULT_FONT_SIZE;
  const sidebar = sizes?.sidebar ?? DEFAULT_FONT_SIZE;

  return (
    <SettingsSection title="Font size">
      <SettingsRow title="Main text" description="The thread and everything outside the sidebars.">
        <PxStepper
          name="main"
          value={main}
          onChange={(next) => setSizes({ main: next, sidebar })}
        />
      </SettingsRow>
      <SettingsRow title="Sidebar" description="The left sidebar and the right dock.">
        <PxStepper
          name="sidebar"
          value={sidebar}
          onChange={(next) => setSizes({ main, sidebar: next })}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

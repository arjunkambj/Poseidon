/**
 * The model picker: a trigger showing the current model, opening the harness
 * picker (`./model-picker/harness-picker`) — a column of round harness
 * avatars, one per enabled connector instance, with the highlighted one's
 * models in a flyout beside it, and a search across all of them. Only the
 * harnesses and models Settings → Models leaves on are listed
 * (`visibleCatalog`), and always the thread's current pick. A pick hands back
 * the instance with the model (`@/lib/model-picks`), because a thread's
 * harness is chosen here too.
 *
 * On a thread that can no longer switch harness (`locked`) the other
 * harnesses stay on the rail but disabled, and their tooltip says to start a
 * new thread. A `disabledReason` — the connector's `restart` switch —
 * disables the whole picker behind a tooltip, the way the other header
 * pickers do, and then it does not open for its key either. `open` and
 * `onOpenChange` make it controllable, so `composer.modelPicker.open` can
 * open it.
 *
 * `variant="settings"` is the same picker behind an outline trigger that
 * names the harness too, for Settings → Models' default model.
 */

import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { Button } from "@poseidon/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@poseidon/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { cn } from "@poseidon/ui/lib/utils";
import * as React from "react";

import { harnessRail } from "@/lib/harness-picker";
import { encodeModelPick, modelPickerGroups, type ModelPick } from "@/lib/model-picks";
import { visibleCatalog } from "@/lib/model-visibility";
import { useModelPickerPrefs } from "@/lib/use-model-picker-prefs";
import { Brain, ChevronDown } from "@honeyicons/react";

import { HarnessPicker } from "./model-picker/harness-picker";

export function ModelPicker({
  catalog,
  instanceId,
  model,
  locked,
  title,
  disabledReason,
  open,
  onOpenChange,
  onPick,
  variant = "composer",
}: {
  readonly catalog: ReadonlyArray<ConnectorModels>;
  /** The instance the thread runs on, or would; `null` when none is enabled. */
  readonly instanceId: ConnectorInstanceId | null;
  readonly model: string;
  /** The thread has run something, so only its own instance can be picked. */
  readonly locked: boolean;
  readonly title: string;
  readonly disabledReason?: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (pick: ModelPick) => void;
  readonly variant?: "composer" | "settings";
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const current: ModelPick = { connectorInstanceId: instanceId, model };

  // Only the harnesses and models Settings leaves on, and always the current pick.
  const visible = visibleCatalog(catalog, useModelPickerPrefs(), current);
  const rail = harnessRail(modelPickerGroups(visible, { instanceId, locked }), current);
  const own = rail.find((entry) => entry.current);
  const listed = own?.items.find((item) => item.current);
  // The current model may be absent from every list (a stale id, a catalog
  // still loading): it is shown verbatim so the picker never lies about it.
  const label = listed?.label ?? (model === "" ? "Choose…" : model);
  const disabled = disabledReason !== undefined;

  const trigger =
    variant === "settings" ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full min-w-0 justify-start"
        aria-label="Default model"
        title={title}
        disabled={disabled}
      />
    ) : (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="max-w-full min-w-0"
        aria-label="Model"
        title={title}
        disabled={disabled}
      />
    );

  const picker = (
    <Popover open={open && !disabled} onOpenChange={(next) => onOpenChange(next)}>
      <PopoverTrigger render={trigger}>
        <Brain variant="bold" data-icon="inline-start" />
        <span
          className={cn(
            "min-w-0 truncate",
            variant === "settings" ? "flex-1 text-left" : "max-w-52",
          )}
        >
          {variant === "settings" && own !== undefined && listed !== undefined
            ? `${own.label} · ${label}`
            : label}
        </span>
        <ChevronDown variant="bold" data-icon="inline-end" className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto" initialFocus={inputRef}>
        <HarnessPicker
          rail={rail}
          current={current}
          {...(listed === undefined && model !== "" ? { unlisted: model } : {})}
          inputRef={inputRef}
          onClose={() => onOpenChange(false)}
          onPick={(pick) => {
            onOpenChange(false);
            if (encodeModelPick(pick) !== encodeModelPick(current)) {
              onPick(pick);
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );

  return disabledReason === undefined ? (
    picker
  ) : (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex min-w-0" />}>{picker}</TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  );
}

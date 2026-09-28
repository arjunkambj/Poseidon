/**
 * "Compare models" on New task, drawn: the toggle beside the workspace picker,
 * and — while the mode is on — the harness picker in compare mode taking the
 * model picker's place (`ThreadSettingsControls`' `modelPicker`), opened by
 * Choose model as the picker would be. The state is `use-compare-models.ts`;
 * the fan-out it sends is `fan-out-plan.ts`.
 *
 * It is the model picker's popup — the column of harness avatars, each with a
 * flyout of its models, and the search across them — with a checkbox on every
 * model, filtered the same way by Settings → Models (a ticked pick always
 * stays listed). Up to `COMPARE_MAX` can be ticked: past that the unticked
 * ones are disabled, and ticking, by Enter or a click, leaves the popup open.
 * Why a send is refused (fewer than two picks) sits beside the toggle, in the
 * row under the composer, where there is room for it.
 *
 * With the mode on the workspace picker is disabled — every model starts in a
 * worktree of its own — and on a project that is not a git repository the
 * toggle itself is disabled, with the reason as its tooltip.
 */

import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import { Button } from "@poseidon/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@poseidon/ui/components/popover";
import { Separator } from "@poseidon/ui/components/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import * as React from "react";

import type { ModelPickerOpen } from "@/components/header-controls";
import { HarnessPicker } from "@/components/model-picker/harness-picker";
import { COMPARE_MAX } from "@/components/thread/fan-out-plan";
import type { CompareModels } from "@/components/thread/use-compare-models";
import {
  WorkspaceModePicker,
  type WorkspaceChoice,
} from "@/components/thread/workspace-mode-picker";
import { harnessRail, type HarnessRailEntry } from "@/lib/harness-picker";
import { emptyPickerText, useModelCatalogState, type EmptyText } from "@/lib/model-catalog-state";
import { encodeModelPick, modelPickerGroups, type ModelPick } from "@/lib/model-picks";
import { visibleCatalog } from "@/lib/model-visibility";
import { useModelPickerPrefs } from "@/lib/use-model-picker-prefs";
import { ChevronDown, Columns } from "@honeyicons/react";

const COMPARE_WORKSPACE = "Compare models starts each model in its own worktree";

export interface CompareMenuItem {
  readonly pick: ModelPick;
  readonly label: string;
  readonly checked: boolean;
  /** Unticked while `COMPARE_MAX` are ticked. */
  readonly disabled: boolean;
}

export interface CompareMenuGroup {
  readonly connector: ConnectorModels["connector"];
  readonly items: ReadonlyArray<CompareMenuItem>;
}

/** The menu's rows: one group per instance, one item per model. */
export const compareMenuGroups = (
  catalog: ReadonlyArray<ConnectorModels>,
  picks: ReadonlyArray<ModelPick>,
): ReadonlyArray<CompareMenuGroup> => {
  const chosen = new Set(picks.map(encodeModelPick));
  const full = picks.length >= COMPARE_MAX;
  return catalog.map(({ connector, models }) => ({
    connector,
    items: models.map((model) => {
      const pick = { connectorInstanceId: connector.connectorInstanceId, model: model.id };
      const checked = chosen.has(encodeModelPick(pick));
      return { pick, label: model.label, checked, disabled: full && !checked };
    }),
  }));
};

/**
 * The harness picker's rail for compare mode, with `compareMenuGroups`' state
 * on it: a model past the cap is disabled, and `checked` holds the ticked
 * picks (`encodeModelPick`). No harness is locked and none is current.
 * `catalog` is what the picker lists; `full`, the unfiltered catalog the
 * monograms are settled over (`harnessRail`).
 */
export const compareRail = (
  catalog: ReadonlyArray<ConnectorModels>,
  picks: ReadonlyArray<ModelPick>,
  full: ReadonlyArray<ConnectorModels> = catalog,
): {
  readonly rail: ReadonlyArray<HarnessRailEntry>;
  readonly checked: ReadonlySet<string>;
} => {
  const rows = new Map(
    compareMenuGroups(catalog, picks)
      .flatMap((group) => group.items)
      .map((item) => [encodeModelPick(item.pick), item] as const),
  );
  const rail = harnessRail(
    modelPickerGroups(catalog, { instanceId: null, locked: false }),
    null,
    full,
  ).map((entry) => ({
    ...entry,
    items: entry.items.map((item) => ({
      ...item,
      disabled: rows.get(item.value)?.disabled ?? item.disabled,
    })),
  }));
  const checked = new Set([...rows].flatMap(([value, item]) => (item.checked ? [value] : [])));
  return { rail, checked };
};

/** The popup's body, without the popup: the harness picker with checkboxes, then the cap. */
export function CompareModelsBody({
  catalog,
  full,
  empty,
  picks,
  inputRef,
  onToggle,
  onClose,
}: {
  /** What the pickers list — already filtered by Settings → Models. */
  readonly catalog: ReadonlyArray<ConnectorModels>;
  /** The unfiltered catalog, for the monograms. */
  readonly full: ReadonlyArray<ConnectorModels>;
  /** What an empty rail says (`emptyPickerText`). */
  readonly empty: EmptyText;
  readonly picks: ReadonlyArray<ModelPick>;
  readonly inputRef?: React.Ref<HTMLInputElement>;
  readonly onToggle: (pick: ModelPick) => void;
  readonly onClose: () => void;
}) {
  const { rail, checked } = compareRail(catalog, picks, full);
  return (
    <>
      <HarnessPicker
        rail={rail}
        current={picks[0] ?? null}
        empty={empty}
        checked={checked}
        {...(inputRef === undefined ? {} : { inputRef })}
        onPick={onToggle}
        onClose={onClose}
      />
      <Separator />
      <p className="px-2 text-xs text-muted-foreground">Up to {COMPARE_MAX} models</p>
    </>
  );
}

/** Stands in for the model picker while the mode is on. */
export function CompareModelsPicker({
  compare,
  catalog,
  open,
  onOpenChange,
}: {
  readonly compare: CompareModels;
  readonly catalog: ReadonlyArray<ConnectorModels>;
} & ModelPickerOpen) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const count = compare.picks.length;
  // Only what Settings → Models leaves on, and every pick already ticked.
  const visible = visibleCatalog(catalog, useModelPickerPrefs(), compare.picks);
  const catalogState = useModelCatalogState();

  return (
    <Popover open={open} onOpenChange={(next) => onOpenChange(next)}>
      <PopoverTrigger
        render={<Button type="button" variant="ghost" size="sm" className="min-w-0 shrink-0" />}
      >
        <Columns variant="bold" data-icon="inline-start" />
        Compare · {count} {count === 1 ? "model" : "models"}
        <ChevronDown variant="bold" data-icon="inline-end" className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-auto" initialFocus={inputRef}>
        <CompareModelsBody
          catalog={visible}
          full={catalog}
          empty={emptyPickerText(catalogState, catalog)}
          picks={compare.picks}
          inputRef={inputRef}
          onToggle={compare.toggle}
          onClose={() => onOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * What stands in for the model picker: the compare-mode harness picker while
 * the mode is on, taking the picker's open state, else nothing.
 */
export const comparePicker = (
  compare: CompareModels,
  catalog: ReadonlyArray<ConnectorModels>,
): ((control: ModelPickerOpen) => React.ReactNode) | undefined =>
  compare.enabled
    ? (control) => <CompareModelsPicker compare={compare} catalog={catalog} {...control} />
    : undefined;

/** The Compare models switch; disabled, with the reason, where it cannot run. */
export function CompareModelsToggle({
  compare,
  disabled = false,
}: {
  readonly compare: Pick<CompareModels, "enabled" | "setEnabled" | "unavailable">;
  readonly disabled?: boolean;
}) {
  const reason = compare.unavailable;
  // The trigger wraps the button: a disabled button takes no pointer events,
  // and the tooltip is where a refused toggle says why.
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button
          type="button"
          variant={compare.enabled ? "secondary" : "ghost"}
          tone={compare.enabled ? "default" : "muted"}
          size="icon-sm"
          aria-label="Compare models"
          aria-pressed={compare.enabled}
          aria-description={reason ?? undefined}
          disabled={disabled || reason !== null}
          onClick={() => compare.setEnabled(!compare.enabled)}
        >
          <Columns variant="bold" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {reason ?? (compare.enabled ? "Stop comparing models" : "Compare models")}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The workspace picker and the toggle, for the composer's context row, then
 * why a compare send is refused. With the mode on the workspace picker is
 * disabled: each model gets its own worktree, whatever it says.
 */
export function CompareWorkspace({
  compare,
  choice,
  disabled,
}: {
  readonly compare: CompareModels;
  readonly choice: WorkspaceChoice;
  readonly disabled: boolean;
}) {
  return (
    <>
      {compare.enabled ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex min-w-0" />}>
            <WorkspaceModePicker choice={choice} disabled />
          </TooltipTrigger>
          <TooltipContent>{COMPARE_WORKSPACE}</TooltipContent>
        </Tooltip>
      ) : (
        <WorkspaceModePicker choice={choice} disabled={disabled} />
      )}
      <CompareModelsToggle compare={compare} disabled={disabled} />
      {compare.refusal === null ? null : (
        <span className="min-w-0 truncate text-xs text-muted-foreground" role="status">
          {compare.refusal}
        </span>
      )}
    </>
  );
}

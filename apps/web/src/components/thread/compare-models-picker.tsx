/**
 * "Compare models" on New task, drawn: the toggle beside the workspace picker,
 * and — while the mode is on — a checkbox menu that takes the model picker's
 * place (`ThreadSettingsControls`' `modelPicker`), opened by Choose model as
 * the picker would be. The state is
 * `use-compare-models.ts`; the fan-out it sends is `fan-out-plan.ts`.
 *
 * The menu lists every enabled instance's models under the instance's name
 * and its connector's icon, as the model picker does. Up to `COMPARE_MAX` can
 * be ticked: past that the unticked ones are disabled, and ticking leaves the
 * menu open. Why a send is refused (fewer than two picks) sits beside the
 * toggle, in the row under the composer, where there is room for it.
 *
 * With the mode on the workspace picker is disabled — every model starts in a
 * worktree of its own — and on a project that is not a git repository the
 * toggle itself is disabled, with the reason as its tooltip.
 */

import { useAtomValue } from "@effect/atom-react";
import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ConnectorDescriptor } from "@poseidon/contracts/connectors";
import { Button } from "@poseidon/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { AsyncResult } from "effect/unstable/reactivity";
import type * as React from "react";

import type { ModelPickerOpen } from "@/components/header-controls";
import { COMPARE_MAX } from "@/components/thread/fan-out-plan";
import type { CompareModels } from "@/components/thread/use-compare-models";
import {
  WorkspaceModePicker,
  type WorkspaceChoice,
} from "@/components/thread/workspace-mode-picker";
import { useClientRuntime } from "@/lib/client-runtime";
import { connectorIconFor } from "@/lib/connector-icon";
import { encodeModelPick, type ModelPick } from "@/lib/model-picks";
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

/** The menu's body, without the popup: it renders inside any open menu. */
export function CompareModelsGroups({
  catalog,
  descriptors,
  picks,
  onToggle,
}: {
  readonly catalog: ReadonlyArray<ConnectorModels>;
  readonly descriptors: ReadonlyArray<ConnectorDescriptor>;
  readonly picks: ReadonlyArray<ModelPick>;
  readonly onToggle: (pick: ModelPick) => void;
}) {
  return (
    <>
      {compareMenuGroups(catalog, picks).map((group) => {
        const Icon = connectorIconFor(
          descriptors.find((entry) => entry.kind === group.connector.kind)?.metadata.iconKey,
        );
        return (
          <DropdownMenuGroup key={group.connector.connectorInstanceId}>
            <DropdownMenuLabel>
              <span className="flex min-w-0 items-center gap-1.5">
                <Icon variant="bold" className="size-3.5 shrink-0" />
                <span className="truncate">{group.connector.displayName}</span>
              </span>
            </DropdownMenuLabel>
            {group.items.map((item) => (
              <DropdownMenuCheckboxItem
                key={encodeModelPick(item.pick)}
                checked={item.checked}
                disabled={item.disabled}
                onCheckedChange={() => onToggle(item.pick)}
              >
                <span className="min-w-0 truncate">{item.label}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        );
      })}
      <DropdownMenuSeparator />
      <p className="px-1.5 py-1 text-xs text-muted-foreground">Up to {COMPARE_MAX} models</p>
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
  const { connectorDescriptorsAtom } = useClientRuntime();
  const descriptorsResult = useAtomValue(connectorDescriptorsAtom);
  const descriptors = AsyncResult.isSuccess(descriptorsResult) ? descriptorsResult.value : [];
  const count = compare.picks.length;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={<Button type="button" variant="ghost" size="sm" className="min-w-0 shrink-0" />}
      >
        <Columns variant="bold" data-icon="inline-start" />
        Compare · {count} {count === 1 ? "model" : "models"}
        <ChevronDown variant="bold" data-icon="inline-end" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-auto max-w-80 min-w-56">
        <CompareModelsGroups
          catalog={catalog}
          descriptors={descriptors}
          picks={compare.picks}
          onToggle={compare.toggle}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * What stands in for the model picker: the checkbox menu while the mode is
 * on, taking the picker's open state, else nothing.
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

/**
 * The thread header controls: model, effort, runtime mode and interaction
 * mode pickers. Every pick is a `thread.settings.update` dispatch — the doc
 * updates when `thread.settings.updated` lands, and a rejected or unreachable
 * dispatch says so beside the pickers instead of letting the value snap back
 * with no explanation.
 *
 * Capability wiring: a `restart` switch disables the picker
 * with a tooltip; `per-turn` adds an "applies next turn" hint; plan mode
 * disappears from the interaction picker when the connector cannot plan. A
 * thread with no bound session reports no capabilities, in which case model
 * and effort behave as per-turn — that is what a fresh session consumes. The
 * model picker lists every enabled instance's models (`./model-picker`); the
 * instance the thread runs on, or would (`@/lib/connector-routing`), decides
 * which section is current and which runtime modes are on offer
 * (`@/lib/runtime-modes`). Once the thread has run anything, the other
 * sections are disabled. Efforts read lowest first in the contract's order
 * (`@/lib/efforts`).
 *
 * Layout: both components render `contents`, so the pickers are flex items
 * of the row they are placed in — the composer toolbar
 * (`./composer/composer-toolbar`) — and follow its `@container/toolbar`
 * width: wide, model and effort sit together beside Send, styled like the
 * runtime-mode picker; narrow, they take a line of their own and the model
 * name truncates, so the pair never wraps inside itself and the runtime mode
 * shows only its icon when even the first line runs short. The context meter
 * (`./composer/context-meter`) stays beside Send either way, and offers
 * "Compact now" when the bound session can compact (`./composer/compact-now`).
 *
 * Keys: `ThreadSettingsKeys` (`./thread-settings-keys`) answers plan mode
 * (Shift+Tab in the composer), the runtime-mode cycle, the pickers and the
 * effort steps through the same `onChange` a click uses; the pickers are
 * controlled here so a key can open them.
 *
 * Ultracode: the toggle beside Plan mode (`./ultracode-toggle`), and every
 * other patch passes `settleUltracode` (`@/lib/ultracode`) so an effort pick,
 * or a model that cannot run it, turns ultracode off.
 */

import { Button } from "@poseidon/ui/components/button";
import { cn } from "@poseidon/ui/lib/utils";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@poseidon/ui/components/tooltip";
import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import { DEFAULT_RUNTIME_MODE, type Effort, RuntimeMode } from "@poseidon/contracts/enums";
import { makeCommandId } from "@poseidon/contracts/ids";
import type { ConnectorInstanceId, ThreadId } from "@poseidon/contracts/ids";
import {
  type ContextWindowUsage,
  threadLocksConnector,
  type ThreadSettingsPatch,
} from "@poseidon/contracts/orchestration";
import type { CapabilitySwitch } from "@poseidon/contracts/runtime";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { useClientRuntime } from "@/lib/client-runtime";
import { instanceCapabilities, threadConnectorInstanceId } from "@/lib/connector-routing";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { orderEfforts, withNote } from "@/lib/efforts";
import { findModel, modelPickPatch } from "@/lib/model-picks";
import { RUNTIME_MODE_LABELS, runtimeModeOptions } from "@/lib/runtime-modes";
import { CommandKbd } from "@/lib/shortcuts";
import { turnInFlight } from "@/lib/turn";
import { settleUltracode, ultracodeOfferedIn } from "@/lib/ultracode";
import { Lightning, ListChecks, Lock } from "@honeyicons/react";

import { canCompact, compactRefusal } from "./composer/compact-now";
import { type ContextCompact, ContextMeter } from "./composer/context-meter";
import { useCompactNow } from "./composer/use-compact-now";
import { type HeaderOption, HeaderSelect, NEXT_TURN_HINT, RESTART_TOOLTIP } from "./header-select";
import { ThreadSettingsKeys } from "./thread-settings-keys";
import { ModelPicker } from "./model-picker";
import { UltracodeToggle } from "./ultracode-toggle";

export function HeaderControls({
  threadId,
  className,
}: {
  readonly threadId: ThreadId;
  readonly className?: string;
}) {
  const { threadDetailAtom, connectorsAtom, modelCatalogAtom, dispatchAtom } = useClientRuntime();
  const docResult = useAtomValue(threadDetailAtom(threadId));
  const doc = AsyncResult.isSuccess(docResult) ? docResult.value : null;
  const connectorsResult = useAtomValue(connectorsAtom);
  const connectors = AsyncResult.isSuccess(connectorsResult) ? connectorsResult.value : [];
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });

  // Capabilities are the *bound* session's: a thread with none behaves as
  // per-turn, because that is what a fresh session consumes.
  const boundInstanceId = doc?.session?.connectorInstanceId ?? null;
  const capabilities =
    connectors.find((c) => c.connectorInstanceId === boundInstanceId)?.capabilities ?? null;
  // Which section of the model picker is the thread's, though, is the
  // instance it runs on or *would* — see `@/lib/connector-routing` — and what
  // that harness can honour is known before any session is bound.
  const instanceId = threadConnectorInstanceId(
    boundInstanceId,
    doc?.settings.connectorInstanceId,
    connectors,
  );
  const catalogResult = useAtomValue(modelCatalogAtom);
  const catalog = AsyncResult.isSuccess(catalogResult) ? catalogResult.value : [];
  const runtimeModes = runtimeModeOptions(instanceCapabilities(instanceId, connectors));

  const [error, setError] = React.useState<string | null>(null);
  const compactNow = useCompactNow(threadId);

  const update = React.useCallback(
    (patch: ThreadSettingsPatch) => {
      setError(null);
      void dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.settings.update",
        threadId,
        ...patch,
      }).then(
        (receipt) => setError(receiptError(receipt, "the server rejected the change")),
        () => setError(DISPATCH_UNREACHABLE),
      );
    },
    [dispatch, threadId],
  );

  if (doc === null) {
    return null;
  }
  const shownError = error ?? compactNow.error;

  return (
    <div className={cn("contents", className)}>
      <ThreadSettingsControls
        settings={doc.settings}
        catalog={catalog}
        connectorInstanceId={instanceId}
        locked={threadLocksConnector(doc)}
        modelSwitch={capabilities?.modelSwitch ?? "per-turn"}
        effortSwitch={capabilities?.effortSwitch ?? "per-turn"}
        canPlan={capabilities?.planMode ?? true}
        runtimeModes={runtimeModes}
        context={doc.context}
        compact={
          canCompact(doc.session?.capabilities)
            ? {
                onCompact: compactNow.compact,
                disabledReason: compactRefusal({
                  running: turnInFlight(doc),
                  pending: compactNow.compacting,
                }),
                pending: compactNow.compacting,
              }
            : undefined
        }
        onChange={update}
      />
      {shownError === null ? null : (
        <p className="order-4 basis-full text-xs text-destructive" role="alert">
          {shownError}
        </p>
      )}
    </div>
  );
}

/** The model picker's open state, handed to whatever is drawn in its place. */
export interface ModelPickerOpen {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ThreadSettingsControls({
  settings,
  catalog,
  connectorInstanceId,
  locked = false,
  modelSwitch = "next-turn",
  effortSwitch = "next-turn",
  canPlan = true,
  runtimeModes = RuntimeMode.literals,
  context = null,
  compact,
  modelPicker,
  onChange,
}: {
  readonly settings: ThreadSettingsPatch;
  /** Every enabled instance's models, one picker section each. */
  readonly catalog: ReadonlyArray<ConnectorModels>;
  /** The instance the thread runs on, or would; `null` when none is enabled. */
  readonly connectorInstanceId: ConnectorInstanceId | null;
  /** The thread has run something: other instances show, disabled. */
  readonly locked?: boolean;
  readonly modelSwitch?: CapabilitySwitch | "next-turn";
  readonly effortSwitch?: CapabilitySwitch | "next-turn";
  readonly canPlan?: boolean;
  /** The modes the thread's connector can honour; every mode when unknown. */
  readonly runtimeModes?: ReadonlyArray<RuntimeMode>;
  /** The thread's last reported usage; `null` before its first turn reports. */
  readonly context?: ContextWindowUsage | null;
  /** "Compact now" in the context meter; only when the bound session can. */
  readonly compact?: ContextCompact;
  /**
   * Drawn in place of the model picker (New task's "Compare models"), with
   * the picker's open state, so Choose model opens it instead.
   */
  readonly modelPicker?: (control: ModelPickerOpen) => React.ReactNode;
  readonly onChange: (patch: ThreadSettingsPatch) => void;
}) {
  const offeredOn = (instance: ConnectorInstanceId | null, model: string | undefined) =>
    ultracodeOfferedIn(catalog, instance, model);
  const ultracode = settings.ultracode === true;
  const change = (patch: ThreadSettingsPatch) =>
    onChange(settleUltracode(patch, ultracode, offeredOn, connectorInstanceId));
  const currentModel =
    settings.model === undefined
      ? undefined
      : findModel(catalog, { connectorInstanceId, model: settings.model });
  const effortOptions: ReadonlyArray<HeaderOption> = orderEfforts(currentModel?.efforts).map(
    (effort) => withNote({ value: effort, label: effort }, effort),
  );
  // A mode the connector cannot honour stays visible while it is the current
  // one — under its own name, not picked again — so the picker never lies.
  const currentMode = settings.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const runtimeModeItems: ReadonlyArray<HeaderOption> = RuntimeMode.literals
    .filter((mode) => runtimeModes.includes(mode) || mode === currentMode)
    .map((mode) =>
      runtimeModes.includes(mode)
        ? { value: mode, label: RUNTIME_MODE_LABELS[mode] }
        : {
            value: mode,
            label: RUNTIME_MODE_LABELS[mode],
            description: "Not supported by this connector",
            disabled: true,
          },
    );

  // Before a turn reports usage, the meter reads 0 of the model's window.
  const contextLimit = context?.limit ?? currentModel?.contextWindow ?? 0;

  const planning = settings.interactionMode === "plan";
  const effort = settings.effort ?? "medium";
  const [modeOpen, setModeOpen] = React.useState(false);
  const [modelOpen, setModelOpen] = React.useState(false);
  const [effortOpen, setEffortOpen] = React.useState(false);
  // The open state belongs to whichever picker is drawn: switching between
  // the model picker and a stand-in starts the new one closed.
  const standIn = modelPicker !== undefined;
  const [drawnStandIn, setDrawnStandIn] = React.useState(standIn);
  if (drawnStandIn !== standIn) {
    setDrawnStandIn(standIn);
    setModelOpen(false);
  }

  return (
    <TooltipProvider>
      <ThreadSettingsKeys
        planOffered={canPlan || planning}
        planning={planning}
        runtimeMode={currentMode}
        runtimeModes={runtimeModes}
        effort={effort}
        efforts={currentModel?.efforts}
        effortLocked={effortSwitch === "restart"}
        onChange={change}
        onOpenModel={() =>
          setModelOpen(standIn || (settings.model !== undefined && modelSwitch !== "restart"))
        }
        onOpenEffort={() => setEffortOpen(effortSwitch !== "restart")}
      />
      <div className="contents">
        <HeaderSelect
          className="shrink-0"
          collapseValue
          icon={Lock}
          label="Runtime mode"
          value={currentMode}
          options={runtimeModeItems}
          capability="next-turn"
          open={modeOpen}
          onOpenChange={setModeOpen}
          onPick={(mode) => change({ runtimeMode: mode as RuntimeMode })}
        />
        {canPlan || planning ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={planning ? "default" : "ghost"}
                  tone={planning ? "default" : "muted"}
                  size={planning ? "sm" : "icon-sm"}
                  className="shrink-0"
                  aria-label="Plan mode"
                  aria-pressed={planning}
                  onClick={() => change({ interactionMode: planning ? "default" : "plan" })}
                />
              }
            >
              <ListChecks variant="bold" data-icon={planning ? "inline-start" : undefined} />
              {planning ? "Plan" : null}
            </TooltipTrigger>
            <TooltipContent>
              {planning ? "Turn off plan mode" : "Plan before making changes"}
              <CommandKbd command="composer.planMode.toggle" />
            </TooltipContent>
          </Tooltip>
        ) : null}
        <UltracodeToggle
          offered={offeredOn(connectorInstanceId, settings.model)}
          on={ultracode}
          onChange={onChange}
        />
        <div className="order-1 flex min-w-0 @max-xl/toolbar:order-3 @max-xl/toolbar:basis-full">
          <div className="flex max-w-full min-w-0 items-center gap-1">
            {modelPicker !== undefined ? (
              modelPicker({ open: modelOpen, onOpenChange: setModelOpen })
            ) : settings.model ? (
              <ModelPicker
                catalog={catalog}
                instanceId={connectorInstanceId}
                model={settings.model}
                locked={locked}
                title={
                  modelSwitch === "per-turn" || modelSwitch === "next-turn"
                    ? NEXT_TURN_HINT
                    : "Model"
                }
                disabledReason={modelSwitch === "restart" ? RESTART_TOOLTIP : undefined}
                open={modelOpen}
                onOpenChange={setModelOpen}
                onPick={(pick) => change(modelPickPatch(pick, locked))}
              />
            ) : null}
            <HeaderSelect
              className="shrink-0"
              icon={Lightning}
              label="Effort"
              value={effort}
              options={effortOptions}
              capability={effortSwitch}
              open={effortOpen}
              onOpenChange={setEffortOpen}
              onPick={(next) => change({ effort: next as Effort })}
            />
          </div>
        </div>
        {contextLimit > 0 ? (
          <ContextMeter
            className="order-2"
            used={context?.used ?? 0}
            limit={contextLimit}
            compact={compact}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

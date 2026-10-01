/**
 * The keys for the thread settings row (`./header-controls`): plan mode, the
 * runtime-mode cycle, the model and effort pickers and the effort steps. Every
 * change goes through the row's own `onChange`, so a key does exactly what the
 * matching click does — a `thread.settings.update` in a thread, a local pick
 * on the start screen.
 *
 * Plan mode is only answered while the row offers it (`canPlan`, or already
 * planning). Its chord is Shift+Tab in the composer, and an unanswered command
 * leaves the key alone, so where plan mode is not on offer Shift+Tab moves the
 * focus as usual. A `restart`-locked knob is left alone too: its picker does
 * not open and its effort does not step.
 *
 * The effort steps never land on the costly multi-agent modes, and a step
 * down from Ultracode turns it off (`effortStepPatch`).
 */

import type { Effort, RuntimeMode } from "@poseidon/contracts/enums";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";

import { effortStepPatch } from "@/lib/effort-menu";
import { nextRuntimeMode } from "@/lib/runtime-modes";
import { useKeybindingCommand } from "@/lib/shortcuts";

/** Answers `composer.planMode.toggle`, mounted only while plan mode is offered. */
function PlanModeKey({ onToggle }: { readonly onToggle: () => void }) {
  useKeybindingCommand("composer.planMode.toggle", onToggle);
  return null;
}

export function ThreadSettingsKeys({
  planOffered,
  planning,
  runtimeMode,
  runtimeModes,
  effort,
  efforts,
  effortLocked,
  ultracode,
  onChange,
  onOpenModel,
  onOpenEffort,
}: {
  readonly planOffered: boolean;
  readonly planning: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly runtimeModes: ReadonlyArray<RuntimeMode>;
  readonly effort: Effort;
  /** The current model's ladder; `undefined` when it states none. */
  readonly efforts: ReadonlyArray<Effort> | undefined;
  readonly effortLocked: boolean;
  /** Ultracode is on: the effort menu's top entry is the current one. */
  readonly ultracode: boolean;
  readonly onChange: (patch: ThreadSettingsPatch) => void;
  /** Opens the model picker; a no-op when it cannot open. */
  readonly onOpenModel: () => void;
  readonly onOpenEffort: () => void;
}) {
  useKeybindingCommand("composer.runtimeMode.cycle", () => {
    const next = nextRuntimeMode(runtimeMode, runtimeModes);
    if (next !== runtimeMode) {
      onChange({ runtimeMode: next });
    }
  });
  useKeybindingCommand("composer.modelPicker.open", onOpenModel);
  useKeybindingCommand("composer.effortPicker.open", onOpenEffort);
  const step = (direction: 1 | -1) => () => {
    const patch = effortStepPatch(effort, efforts, ultracode, direction);
    if (!effortLocked && patch !== null) {
      onChange(patch);
    }
  };
  useKeybindingCommand("composer.effort.increase", step(1));
  useKeybindingCommand("composer.effort.decrease", step(-1));

  return planOffered ? (
    <PlanModeKey onToggle={() => onChange({ interactionMode: planning ? "default" : "plan" })} />
  ) : null;
}

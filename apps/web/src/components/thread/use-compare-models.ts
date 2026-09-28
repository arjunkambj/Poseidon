/**
 * "Compare models" on New task, as the start composer holds it: whether the
 * mode is on, which models are chosen, why a send is refused, and the lanes a
 * send fans out into (`fan-out-plan.ts`). It is React state on the composer,
 * not remembered anywhere: leaving New task ends the mode.
 *
 * Turning the mode on starts the list with the model the composer shows, so
 * one more pick makes a comparison. A project that is not a git repository
 * cannot have worktrees, so there the mode is off whatever was toggled, and
 * `unavailable` says why. Drawing the picker is `compare-models-picker.tsx`.
 */

import { useAtomValue } from "@effect/atom-react";
import { makeThreadId } from "@poseidon/contracts/ids";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import {
  compareRefusal,
  planFanOut,
  toggleComparePick,
  type FanOutLane,
} from "@/components/thread/fan-out-plan";
import type { WorkspaceChoice } from "@/components/thread/workspace-mode-picker";
import { useAppAtoms } from "@/lib/app-runtime";
import { instanceCapabilities } from "@/lib/connector-routing";
import { findModel, type ModelPick } from "@/lib/model-picks";
import { runtimeModeOptions } from "@/lib/runtime-modes";

export interface CompareModels {
  /** The mode is on (and the project can have worktrees). */
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
  readonly picks: ReadonlyArray<ModelPick>;
  readonly toggle: (pick: ModelPick) => void;
  /** Why a compare send is refused; `null` when it can go, or the mode is off. */
  readonly refusal: string | null;
  /** Why the mode cannot be turned on here; `null` when it can. */
  readonly unavailable: string | null;
  /** The lanes a send of `text` fans out into, one per pick. */
  readonly plan: (text: string) => ReadonlyArray<FanOutLane>;
}

/**
 * The start composer's compare mode. `settings` are what its controls show
 * (the model to start from, and the effort and runtime mode every lane gets
 * where it accepts them); `choice` gives the base branch.
 */
export const useCompareModels = (
  settings: ThreadSettingsPatch,
  choice: WorkspaceChoice,
): CompareModels => {
  const atoms = useAppAtoms();
  const catalogResult = useAtomValue(atoms.modelCatalogAtom);
  const catalog = AsyncResult.isSuccess(catalogResult) ? catalogResult.value : [];
  const connectorsResult = useAtomValue(atoms.connectorsAtom);
  const connectors = AsyncResult.isSuccess(connectorsResult) ? connectorsResult.value : [];

  const [toggled, setToggled] = React.useState(false);
  const [picks, setPicks] = React.useState<ReadonlyArray<ModelPick>>([]);
  const enabled = toggled && choice.worktreeAllowed;

  // The shown model, under the instance that lists it; a model no instance
  // lists would be a pick the menu cannot show or take back.
  const shown = (): ReadonlyArray<ModelPick> => {
    const model = settings.model;
    const listing = catalog.find(
      ({ connector, models }) =>
        (settings.connectorInstanceId === undefined ||
          connector.connectorInstanceId === settings.connectorInstanceId) &&
        models.some((option) => option.id === model),
    );
    return model === undefined || listing === undefined
      ? []
      : [{ connectorInstanceId: listing.connector.connectorInstanceId, model }];
  };

  return {
    enabled,
    setEnabled: (next) => {
      if (next) {
        setPicks(shown());
      }
      setToggled(next);
    },
    picks,
    toggle: (pick) => setPicks((current) => toggleComparePick(current, pick)),
    refusal: enabled
      ? compareRefusal({ worktreeAllowed: choice.worktreeAllowed, pickCount: picks.length })
      : null,
    unavailable: choice.worktreeAllowed
      ? null
      : compareRefusal({ worktreeAllowed: false, pickCount: picks.length }),
    plan: (text) =>
      planFanOut({
        text,
        picks: picks.map((pick) => ({ pick, option: findModel(catalog, pick) })),
        base: {
          ...(settings.effort === undefined ? {} : { effort: settings.effort }),
          ...(settings.runtimeMode === undefined ? {} : { runtimeMode: settings.runtimeMode }),
        },
        runtimeModesFor: (instanceId) =>
          runtimeModeOptions(instanceCapabilities(instanceId, connectors)),
        baseBranch: choice.baseBranch,
        mintThreadId: makeThreadId,
      }),
  };
};

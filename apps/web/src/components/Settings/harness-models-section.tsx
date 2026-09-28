/**
 * Settings → Models' harness section: one `HarnessCard` per enabled connector
 * instance in `modelCatalogAtom` — the whole catalog, not the pickers' view of
 * it — with "Enable all" and "Reset to defaults" above them. The switches are
 * the settings document's `modelPicker` and only filter what the model pickers
 * offer; see `@/lib/model-visibility`.
 *
 * An instance switched off on the Connectors page is not in the catalog at
 * all, so it gets no card; one muted line names such instances instead. While
 * the catalog is still asking the harnesses for their models the section says
 * so, and a catalog that failed says why, rather than "no harness enabled".
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ModelPickerSettings } from "@poseidon/contracts/settings";
import { Button } from "@poseidon/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";
import { Link } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { catalogMonograms } from "@/lib/harness-monogram";
import { modelCatalogState } from "@/lib/model-catalog-state";
import { enableAll, resetVisibility } from "@/lib/model-visibility";
import { useModelPickerPrefs } from "@/lib/use-model-picker-prefs";
import { Brain, CheckDouble, RotateCcw } from "@honeyicons/react";

import { HarnessCard } from "./harness-card";
import { SettingsSection } from "./settings-section";

export function HarnessModelsSection() {
  const atoms = useAppAtoms();
  const settingsResult = useAtomValue(atoms.settingsAtom);
  const catalogResult = useAtomValue(atoms.modelCatalogAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "promiseExit" });
  const prefs = useModelPickerPrefs();

  const catalog = AsyncResult.isSuccess(catalogResult) ? catalogResult.value : [];
  const catalogState = modelCatalogState(catalogResult);
  const connectors = AsyncResult.isSuccess(settingsResult)
    ? (settingsResult.value?.connectors ?? [])
    : [];
  const switchedOff = connectors.filter((connector) => !connector.enabled);
  const monograms = catalogMonograms(catalog);

  const save = async (modelPicker: ModelPickerSettings) => {
    const exit = await updateSettings({ modelPicker });
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not save settings"));
    }
  };

  return (
    <SettingsSection
      title="Harnesses and models"
      description="Which harnesses and models the model pickers offer. Switching one off hides it from the pickers only."
      card={false}
    >
      {catalogState.status === "loading" ? (
        <p className="text-xs text-muted-foreground">Loading harnesses…</p>
      ) : catalogState.status === "failed" ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Brain variant="bold" />
            </EmptyMedia>
            <EmptyTitle>Could not list the harnesses</EmptyTitle>
            <EmptyDescription>{catalogState.message}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : catalog.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Brain variant="bold" />
            </EmptyMedia>
            <EmptyTitle>No harness enabled</EmptyTitle>
            <EmptyDescription>Enable a connector to choose its models here.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link to="/settings/connectors" />}
            >
              Open Connectors
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => void save(enableAll(catalog))}>
              <CheckDouble variant="bold" data-icon="inline-start" />
              Enable all
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void save(resetVisibility())}>
              <RotateCcw variant="bold" data-icon="inline-start" />
              Reset to defaults
            </Button>
          </div>
          {catalog.map((group) => (
            <HarnessCard
              key={group.connector.connectorInstanceId}
              group={group}
              catalog={catalog}
              monogram={monograms.get(group.connector.connectorInstanceId) ?? "?"}
              prefs={prefs}
              onChange={(next) => void save(next)}
            />
          ))}
        </>
      )}
      {switchedOff.length === 0 ? null : (
        <p className="text-xs text-muted-foreground">
          Switched off on the Connectors page, so not listed:{" "}
          {switchedOff.map((connector) => connector.displayName).join(", ")}.
        </p>
      )}
    </SettingsSection>
  );
}

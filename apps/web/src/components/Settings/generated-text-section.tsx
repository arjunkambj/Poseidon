/**
 * Settings → Models' "Generated text" section: which harness and model write
 * commit messages, pull request text and thread titles, how hard it thinks,
 * and whether a new thread is named from its first message.
 *
 * The Writing model is a stock grouped select rather than the harness picker,
 * because its first choice, "Same as the thread", is no model at all
 * (`./writing-model-options` builds the rest). Every write sends the whole
 * `generation` struct, spread from the document this render holds: a patch
 * replaces each key it carries.
 */

import { useAtomSet } from "@effect/atom-react";
import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import {
  WritingEffort,
  type GenerationSettings,
  type WritingEffort as WritingEffortValue,
} from "@poseidon/contracts/generation";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@poseidon/ui/components/select";
import { Switch } from "@poseidon/ui/components/switch";
import * as Exit from "effect/Exit";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { EFFORT_LABELS } from "@/lib/efforts";
import type { ModelCatalogState } from "@/lib/model-catalog-state";
import { useModelPickerPrefs } from "@/lib/use-model-picker-prefs";
import { useConnectionState } from "@/state/hooks";

import { SettingsRow, SettingsSection } from "./settings-section";
import {
  SAME_AS_THREAD,
  SAME_AS_THREAD_LABEL,
  writingModelDescription,
  writingModelGroups,
  writingModelLabel,
  writingModelOf,
  writingModelValue,
} from "./writing-model-options";

export function GeneratedTextSection({
  generation,
  catalog,
  catalogState,
}: {
  readonly generation: GenerationSettings;
  /** Every enabled instance's models, unfiltered: the options filter them. */
  readonly catalog: ReadonlyArray<ConnectorModels>;
  /** Whether the catalog has answered, so an empty one is not read as "nothing can write". */
  readonly catalogState: ModelCatalogState;
}) {
  const atoms = useAppAtoms();
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "promiseExit" });
  const connected = useConnectionState().status === "connected";
  const groups = writingModelGroups(catalog, useModelPickerPrefs(), generation.writingModel);

  const save = async (patch: Partial<GenerationSettings>) => {
    const exit = await updateSettings({ generation: { ...generation, ...patch } });
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not save settings"));
    }
  };

  return (
    <SettingsSection
      title="Generated text"
      description="Commit messages, pull request text and thread titles a model writes for you."
    >
      <SettingsRow
        title="Writing model"
        description={writingModelDescription(catalogState, groups)}
      >
        <Select
          value={writingModelValue(generation.writingModel)}
          disabled={!connected}
          onValueChange={(next) => {
            const writingModel = typeof next === "string" ? writingModelOf(next) : undefined;
            if (writingModel !== undefined) {
              void save({ writingModel });
            }
          }}
        >
          <SelectTrigger className="w-72" aria-label="Writing model">
            <SelectValue>{(value) => writingModelLabel(groups, value)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SAME_AS_THREAD}>{SAME_AS_THREAD_LABEL}</SelectItem>
            {groups.map((group) => (
              <SelectGroup key={group.connectorInstanceId}>
                <SelectLabel>{group.displayName}</SelectLabel>
                {group.items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow
        title="Writing effort"
        description="How hard the writing model thinks, where it takes an effort."
      >
        <Select
          value={generation.writingEffort}
          disabled={!connected}
          onValueChange={(next) => {
            const writingEffort = WritingEffort.literals.find((effort) => effort === next);
            if (writingEffort !== undefined) {
              void save({ writingEffort });
            }
          }}
        >
          <SelectTrigger className="w-36" aria-label="Writing effort">
            <SelectValue>{(value: WritingEffortValue) => EFFORT_LABELS[value]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {WritingEffort.literals.map((effort) => (
              <SelectItem key={effort} value={effort}>
                {EFFORT_LABELS[effort]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow
        title="Name new threads automatically"
        htmlFor="generation-auto-title"
        description="Titles a new thread from its first message. A rename always wins."
      >
        <Switch
          id="generation-auto-title"
          aria-label="Name new threads automatically"
          checked={generation.autoTitle}
          disabled={!connected}
          onCheckedChange={(autoTitle) => void save({ autoTitle })}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

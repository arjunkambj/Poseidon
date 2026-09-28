/**
 * The Git & worktrees page: the prefix a new worktree's branch starts with
 * (`git.branchPrefix`) and each project's setup script
 * (`projectSettings[projectId].setupScript`).
 *
 * Both are read from the settings subscription and written through
 * `settings.update`. A patch replaces every key it carries, so a script is
 * saved by writing the whole `projectSettings` record, built at the moment of
 * the click from the latest document (`./git-settings`) — saving one project
 * never drops another's script.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";
import { Input } from "@poseidon/ui/components/input";
import { DEFAULT_BRANCH_PREFIX, type SettingsPatch } from "@poseidon/contracts/settings";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { useConnectionState, useProjects } from "@/state/hooks";
import { GitBranch } from "@honeyicons/react";

import { prefixProblem, prefixToSave, withSetupScript } from "./git-settings";
import { SettingsPageHeader, SettingsRow, SettingsSection } from "./settings-section";
import { SetupScriptCard } from "./setup-script-card";

function BranchPrefixField({
  saved,
  disabled,
  onSave,
}: {
  readonly saved: string;
  readonly disabled: boolean;
  readonly onSave: (prefix: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  // Clicking Save blurs the input first, so both handlers fire: the second is
  // dropped while the first is in flight, rather than writing (and toasting)
  // the same prefix again.
  const saving = React.useRef(false);
  const shown = draft ?? saved;
  const problem = prefixProblem(shown.trim());
  const next = prefixToSave(saved, shown);

  const save = async () => {
    if (next === null) {
      setDraft(null);
      return;
    }
    if (problem !== null || saving.current) {
      return;
    }
    saving.current = true;
    const ok = await onSave(next);
    saving.current = false;
    if (ok) {
      setDraft(null);
    }
  };

  return (
    <SettingsRow
      title="Branch prefix"
      htmlFor="git-branch-prefix"
      description={
        <span
          id="git-branch-prefix-help"
          className={problem === null ? undefined : "text-destructive"}
        >
          {problem ??
            `Put in front of the branch every new worktree is created on, as in “${DEFAULT_BRANCH_PREFIX}fix-login”. The default is “${DEFAULT_BRANCH_PREFIX}”; leave it empty for no prefix.`}
        </span>
      }
    >
      <Input
        id="git-branch-prefix"
        className="w-48"
        value={shown}
        placeholder={DEFAULT_BRANCH_PREFIX}
        spellCheck={false}
        disabled={disabled}
        aria-invalid={problem !== null}
        aria-describedby="git-branch-prefix-help"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={disabled || next === null || problem !== null}
        onClick={() => void save()}
      >
        Save
      </Button>
    </SettingsRow>
  );
}

export function GitPanel() {
  const atoms = useAppAtoms();
  const settingsResult = useAtomValue(atoms.settingsAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "promiseExit" });
  const projects = useProjects();
  const connection = useConnectionState();

  const settings = AsyncResult.isSuccess(settingsResult) ? settingsResult.value : null;
  if (settings === null) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }

  const disabled = connection.status !== "connected";

  const save = async (patch: SettingsPatch, done: string, failed: string) => {
    const exit = await updateSettings(patch);
    if (Exit.isSuccess(exit)) {
      toast.success(done);
      return true;
    }
    toast.error(describeExitError(exit, failed));
    return false;
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="Git & worktrees"
        description="How a thread started in a new worktree names its branch, and what runs in the worktree before the first turn."
      />

      <SettingsSection title="Branches">
        <BranchPrefixField
          saved={settings.git.branchPrefix}
          disabled={disabled}
          onSave={(branchPrefix) =>
            save(
              { git: { ...settings.git, branchPrefix } },
              "Branch prefix saved",
              "Could not save the branch prefix",
            )
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Setup scripts"
        card={false}
        description={
          <>
            Runs with <code className="font-mono">sh -c</code> in each new worktree of the project,
            from the worktree’s root, with <code className="font-mono">POSEIDON_WORKTREE_PATH</code>{" "}
            and <code className="font-mono">POSEIDON_PROJECT_ROOT</code> set. Its output shows while
            the thread starts. Local threads never run it.
          </>
        }
      >
        {projects.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GitBranch variant="bold" />
              </EmptyMedia>
              <EmptyTitle>No projects</EmptyTitle>
              <EmptyDescription>
                Add a project and its setup script can be written here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-4">
            {projects.map((project) => (
              <SetupScriptCard
                key={project.projectId}
                project={project}
                saved={settings.projectSettings[project.projectId]?.setupScript ?? ""}
                disabled={disabled}
                onSave={async (draft) => {
                  // Built from the document this render holds — the latest one the
                  // subscription delivered — so other projects' scripts survive.
                  const projectSettings = withSetupScript(
                    settings.projectSettings,
                    project.projectId,
                    draft,
                  );
                  if (projectSettings === null) {
                    return true;
                  }
                  return save(
                    { projectSettings },
                    `Setup script for ${project.name} saved`,
                    "Could not save the setup script",
                  );
                }}
              />
            ))}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

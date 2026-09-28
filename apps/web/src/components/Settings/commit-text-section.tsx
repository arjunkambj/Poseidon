/**
 * The Git & worktrees page's "Commit and PR text" section — where generated
 * commit and pull request text takes its style from, the repository's PR
 * template, and what the commit dialog's message starts as — and the Branches
 * section's "Start new worktrees from origin" switch.
 *
 * Both are presentational: the page hands in `git` and writes each change as
 * the whole struct spread from its latest document, so the branch prefix and
 * every other field survive. Custom instructions show only for the Custom
 * style and save on blur, trimmed; more than `CUSTOM_INSTRUCTIONS_MAX`
 * characters are refused with a message rather than cut short.
 */

import * as React from "react";

import {
  CommitDraftMode,
  CUSTOM_INSTRUCTIONS_MAX,
  WritingStyle,
} from "@poseidon/contracts/generation";
import type { GitSettings } from "@poseidon/contracts/settings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@poseidon/ui/components/select";
import { Switch } from "@poseidon/ui/components/switch";
import { Textarea } from "@poseidon/ui/components/textarea";

import { instructionsProblem, instructionsToSave } from "./git-settings";
import { SettingsRow, SettingsSection } from "./settings-section";

type GitChange = (patch: Partial<GitSettings>) => void;

const WRITING_STYLE_LABELS: Readonly<Record<WritingStyle, string>> = {
  repository: "Repository conventions",
  conventional: "Conventional Commits",
  custom: "Custom",
};

const DRAFT_MODE_LABELS: Readonly<Record<CommitDraftMode, string>> = {
  template: "Template",
  generate: "Generate when the dialog opens",
};

function LabelledSelect<A extends string>({
  label,
  value,
  options,
  labels,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: A;
  readonly options: ReadonlyArray<A>;
  readonly labels: Readonly<Record<A, string>>;
  readonly disabled: boolean;
  readonly onChange: (next: A) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const picked = options.find((option) => option === next);
        if (picked !== undefined && picked !== value) {
          onChange(picked);
        }
      }}
    >
      <SelectTrigger className="w-60" aria-label={label}>
        <SelectValue>{(shown: A) => labels[shown]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {labels[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CustomInstructionsField({
  saved,
  disabled,
  onSave,
}: {
  readonly saved: string;
  readonly disabled: boolean;
  readonly onSave: (instructions: string) => void;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const shown = draft ?? saved;
  const problem = instructionsProblem(shown);

  const save = () => {
    const next = instructionsToSave(saved, shown);
    if (next === null) {
      setDraft(null);
    } else if (problem === null) {
      onSave(next);
      setDraft(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <label htmlFor="git-custom-instructions" className="text-sm font-medium">
        Custom instructions
      </label>
      <Textarea
        id="git-custom-instructions"
        value={shown}
        placeholder="Write subjects in the past tense, and name the ticket in the body."
        disabled={disabled}
        aria-invalid={problem !== null}
        aria-describedby="git-custom-instructions-help"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
      />
      <div
        id="git-custom-instructions-help"
        className="flex justify-between gap-4 text-xs text-muted-foreground"
      >
        <span className={problem === null ? undefined : "text-destructive"}>
          {problem ?? "Passed to the writing model as they are. Saved when you leave the field."}
        </span>
        <span className="shrink-0 tabular-nums">
          {shown.trim().length.toLocaleString("en-US")} /{" "}
          {CUSTOM_INSTRUCTIONS_MAX.toLocaleString("en-US")}
        </span>
      </div>
    </div>
  );
}

/** The "Commit and PR text" section. */
export function CommitTextSection({
  git,
  disabled,
  onChange,
}: {
  readonly git: GitSettings;
  readonly disabled: boolean;
  readonly onChange: GitChange;
}) {
  return (
    <SettingsSection
      title="Commit and PR text"
      description="How a model writes commit messages and pull request text when you ask it to."
    >
      <SettingsRow
        title="Writing style"
        description="Repository conventions follows recent commit subjects and the agent notes."
      >
        <LabelledSelect
          label="Writing style"
          value={git.writingStyle}
          options={WritingStyle.literals}
          labels={WRITING_STYLE_LABELS}
          disabled={disabled}
          onChange={(writingStyle) => onChange({ writingStyle })}
        />
      </SettingsRow>
      {git.writingStyle === "custom" ? (
        <CustomInstructionsField
          saved={git.customInstructions}
          disabled={disabled}
          onSave={(customInstructions) => onChange({ customInstructions })}
        />
      ) : null}
      <SettingsRow
        title="Follow the repository's PR template"
        htmlFor="git-follow-pr-template"
        description="Without a template, the body is a Summary and a Testing section."
      >
        <Switch
          id="git-follow-pr-template"
          aria-label="Follow the repository's PR template"
          checked={git.followPrTemplate}
          disabled={disabled}
          onCheckedChange={(followPrTemplate) => onChange({ followPrTemplate })}
        />
      </SettingsRow>
      <SettingsRow
        title="Draft commit messages"
        description="What the commit dialog's message starts as. Generate is always one click away."
      >
        <LabelledSelect
          label="Draft commit messages"
          value={git.draftCommitMessages}
          options={CommitDraftMode.literals}
          labels={DRAFT_MODE_LABELS}
          disabled={disabled}
          onChange={(draftCommitMessages) => onChange({ draftCommitMessages })}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

/** The Branches section's "Start new worktrees from origin" row. */
export function WorktreeFromOriginRow({
  git,
  disabled,
  onChange,
}: {
  readonly git: GitSettings;
  readonly disabled: boolean;
  readonly onChange: GitChange;
}) {
  return (
    <SettingsRow
      title="Start new worktrees from origin"
      htmlFor="git-worktree-from-origin"
      description="Fetches the base branch first. When that fails, the local branch is used and you are told."
    >
      <Switch
        id="git-worktree-from-origin"
        aria-label="Start new worktrees from origin"
        checked={git.worktreeFromOrigin}
        disabled={disabled}
        onCheckedChange={(worktreeFromOrigin) => onChange({ worktreeFromOrigin })}
      />
    </SettingsRow>
  );
}

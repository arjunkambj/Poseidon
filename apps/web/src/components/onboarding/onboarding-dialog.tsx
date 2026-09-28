/**
 * First-run setup: harnesses, theme, a project, and — when a harness has
 * sessions of its own — importing them (`onboardingSteps`). Back and Next
 * walk the steps; Skip setup, Finish and the close button all end it the same
 * way, by writing `onboardingCompleted`, so it never opens by itself again.
 *
 * Mounted only while open (`./onboarding-host`), so each opening starts on
 * the first step, and the importable-session list is read only then.
 */

import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";

import { DialogActions } from "@/components/dialog-actions";
import { ThemeCards } from "@/components/Settings/theme-cards";
import { useAddProjectForm } from "@/components/sidebar/add-project-form";
import { useAppAtoms } from "@/lib/app-runtime";
import { onboardingSteps, type OnboardingStep } from "@/lib/onboarding";

import { HarnessStep } from "./harness-step";
import { ImportStep, ProjectStep } from "./setup-steps";

const STEP_COPY: Record<OnboardingStep, { title: string; description: string }> = {
  harnesses: {
    title: "Harnesses",
    description:
      "Poseidon runs the coding agents installed on this computer. Install or sign in to the ones you want to use.",
  },
  theme: { title: "Theme", description: "Pick how Poseidon looks. Settings → General changes it." },
  project: {
    title: "Add a project",
    description: "A project is a folder on this computer the agent works in.",
  },
  import: {
    title: "Import sessions",
    description:
      "Bring in sessions your harnesses recorded outside Poseidon as threads. Their files are only read, never changed.",
  },
};

/** Focus in the terminal: Escape is the shell's, not a request to close. */
const escapeInTerminal = (reason: string): boolean =>
  reason === "escape-key" && document.activeElement?.closest(".xterm") != null;

export function OnboardingDialog({ onDone }: { readonly onDone: () => void }) {
  const atoms = useAppAtoms();
  const importable = useAtomValue(atoms.importableSessionsAtom);
  const [index, setIndex] = React.useState(0);
  const [added, setAdded] = React.useState<ReadonlyArray<string>>([]);
  const form = useAddProjectForm((project) => setAdded((names) => [...names, project.name]));
  // Focus opens on Next rather than the first control, a row's copy button,
  // whose tooltip would greet every opening.
  const primary = React.useRef<HTMLButtonElement>(null);

  const steps = onboardingSteps(
    AsyncResult.isSuccess(importable)
      ? importable.value.length
      : AsyncResult.isFailure(importable)
        ? 0
        : null,
  );
  // The import step can drop out while it is open, if its list answers empty.
  const at = Math.min(index, steps.length - 1);
  const step = steps[at] ?? "harnesses";
  const last = at === steps.length - 1;

  return (
    <>
      <Dialog
        open
        onOpenChange={(next, details) => {
          if (!next && !escapeInTerminal(details.reason)) onDone();
        }}
      >
        <DialogContent
          initialFocus={primary}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
        >
          <DialogHeader>
            <span className="type-micro text-muted-foreground">
              Set up Poseidon · Step {at + 1} of {steps.length}
            </span>
            <DialogTitle>{STEP_COPY[step].title}</DialogTitle>
            <DialogDescription>{STEP_COPY[step].description}</DialogDescription>
          </DialogHeader>
          {step === "harnesses" ? <HarnessStep /> : null}
          {step === "theme" ? <ThemeCards /> : null}
          {step === "project" ? <ProjectStep form={form} added={added} /> : null}
          {step === "import" ? <ImportStep onDone={onDone} /> : null}
          <DialogActions>
            <Button
              type="button"
              variant="ghost"
              tone="muted"
              className="sm:mr-auto"
              onClick={onDone}
            >
              Skip setup
            </Button>
            {at === 0 ? null : (
              <Button type="button" variant="outline" onClick={() => setIndex(at - 1)}>
                Back
              </Button>
            )}
            {last ? (
              <Button ref={primary} type="button" onClick={onDone}>
                Finish
              </Button>
            ) : (
              <Button ref={primary} type="button" onClick={() => setIndex(at + 1)}>
                Next
              </Button>
            )}
          </DialogActions>
        </DialogContent>
      </Dialog>
      {/* Beside the dialog, not in it — see `@/components/sidebar/add-project-form`. */}
      {form.picker}
    </>
  );
}

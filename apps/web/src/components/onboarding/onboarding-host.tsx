/**
 * Where first-run setup lives: mounted once at the app root, so the palette's
 * "Set up Poseidon…" (`onboarding.open`) and Settings → General's "Run setup
 * again" open it on any route. It opens by itself once, when the project
 * list and the settings have both loaded and say this is a fresh install
 * (`shouldOpenOnboarding`); ending it any way writes `onboardingCompleted`.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";
import { toast } from "sonner";

import { TooltipProvider } from "@poseidon/ui/components/tooltip";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { shouldOpenOnboarding } from "@/lib/onboarding";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { useLoadedProjects } from "@/state/hooks";
import { useOnboardingOpen } from "@/state/onboarding";

import { OnboardingDialog } from "./onboarding-dialog";

const ONBOARDING_OPEN_COMMAND = "onboarding.open";

export function OnboardingHost() {
  const atoms = useAppAtoms();
  const settingsResult = useAtomValue(atoms.settingsAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "promiseExit" });
  const projects = useLoadedProjects();
  const [open, setOpen] = useOnboardingOpen();
  // Once per launch: the write that marks it done lands a moment after the
  // dialog closes, and must not find the old settings and open it again.
  const autoOpened = React.useRef(false);

  const settings = AsyncResult.isSuccess(settingsResult) ? settingsResult.value : null;
  const fresh = shouldOpenOnboarding(projects, settings);

  React.useEffect(() => {
    if (fresh && !autoOpened.current) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [fresh, setOpen]);

  useKeybindingCommand(ONBOARDING_OPEN_COMMAND, () => setOpen(true));

  const done = async () => {
    setOpen(false);
    if (settings?.onboardingCompleted === true) return;
    const exit = await updateSettings({ onboardingCompleted: true });
    if (!Exit.isSuccess(exit)) {
      toast.error(describeExitError(exit, "Could not save settings"));
    }
  };

  // Above the layouts, so it brings the tooltip delay they give their own.
  return open ? (
    <TooltipProvider delay={300}>
      <OnboardingDialog onDone={() => void done()} />
    </TooltipProvider>
  ) : null;
}

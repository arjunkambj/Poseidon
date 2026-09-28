/**
 * Whether first-run setup is open. One atom, so the host mounted at the app
 * root (`@/components/onboarding/onboarding-host`), Settings → General and
 * the palette all open the same dialog.
 */

import { useAtom } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";

const onboardingOpenAtom = Atom.keepAlive(Atom.make(false));

/** `[open, setOpen]` for first-run setup. */
export const useOnboardingOpen = () => useAtom(onboardingOpenAtom);

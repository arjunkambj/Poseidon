/**
 * The General page: the theme cards, the main and sidebar font sizes, the chat
 * width, and a reset that puts every appearance choice back to its default. New-thread defaults (model,
 * effort, runtime mode) live on the Models page.
 */

import { useAtomSet } from "@effect/atom-react";

import { Button } from "@poseidon/ui/components/button";
import { DEFAULT_CHAT_WIDTH, DEFAULT_FONT_SIZE } from "@poseidon/contracts/settings";

import { useTheme } from "@/components/theme-provider";
import { useAppAtoms } from "@/lib/app-runtime";
import { applyFontSizes } from "@/lib/font-size";
import { useResetLayoutWidths } from "@/state/ui";

import { ChatWidthToggle } from "./chat-width-toggle";
import { FontSizeSteppers } from "./font-size-steppers";
import { ThemeCards } from "./theme-cards";

function ResetAppearance() {
  const { setTheme } = useTheme();
  const atoms = useAppAtoms();
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "value" });
  const resetLayoutWidths = useResetLayoutWidths();

  const reset = () => {
    setTheme("system");
    applyFontSizes({ main: DEFAULT_FONT_SIZE, sidebar: DEFAULT_FONT_SIZE });
    updateSettings({
      theme: "system",
      mainFontSize: DEFAULT_FONT_SIZE,
      sidebarFontSize: DEFAULT_FONT_SIZE,
      chatWidth: DEFAULT_CHAT_WIDTH,
    });
    resetLayoutWidths();
  };

  return (
    <div>
      <h2 className="mb-1 text-sm font-medium">Reset appearance</h2>
      <p className="mb-2 text-sm text-muted-foreground">
        Theme, font sizes, chat width, and the sidebar and dock widths go back to their defaults.
      </p>
      <Button variant="outline" onClick={reset}>
        Reset to defaults
      </Button>
    </div>
  );
}

export function GeneralPanel() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">General</h1>
        <p className="mt-1 text-sm text-muted-foreground">How the app looks.</p>
      </div>

      <ThemeCards />
      <FontSizeSteppers />
      <ChatWidthToggle />
      <ResetAppearance />
    </div>
  );
}

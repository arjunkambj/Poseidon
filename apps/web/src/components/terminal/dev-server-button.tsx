/**
 * The drawer toolbar's "Open in browser" button: shown while the tab in front
 * is a running script that has printed a dev server (`./dev-servers`), and
 * labelled with its `host:port`. It opens the first one the script printed
 * through the drawer's `onOpenLink` — the thread's browser pane, or on the
 * New task page the system browser. Nothing opens until it is clicked.
 */

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import type { TerminalTab } from "@/components/terminal/drawer-state";
import { devServerLabel } from "@/components/terminal/dev-server-urls";
import { useDevServerUrls } from "@/components/terminal/dev-servers";
import { Globe } from "@honeyicons/react";

export function DevServerButton({
  tab,
  onOpenLink,
}: {
  /** The tab in front, if any. */
  tab: TerminalTab | undefined;
  onOpenLink: (url: string) => void;
}) {
  const urls = useDevServerUrls(tab?.terminalId ?? null);
  const url = urls[0];
  if (tab === undefined || tab.script === null || tab.status !== "running" || url === undefined) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            tone="muted"
            size="xs"
            className="shrink-0"
            aria-label={`Open ${devServerLabel(url)} in browser`}
            onClick={() => onOpenLink(url)}
          />
        }
      >
        <Globe variant="bold" />
        {devServerLabel(url)}
      </TooltipTrigger>
      <TooltipContent>Open in browser</TooltipContent>
    </Tooltip>
  );
}

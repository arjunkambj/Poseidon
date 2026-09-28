/**
 * What the pane shows when the browser tool is missing, on the stock `Empty`:
 * the commands the mode needs, each copyable, and a retry (a reload gesture —
 * in-app it clears the error for the agent's next call, in owned mode it
 * starts the browser again).
 *
 * This replaces the error string being squeezed into the toolbar chip — the
 * one failure the user can actually fix deserves the whole surface.
 */
import type { BrowserState } from "@poseidon/contracts/rpc";
import { Button } from "@poseidon/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";

import { CopyCommand } from "@/components/copy-command";

import { installCommands } from "./install";
import { Globe } from "@honeyicons/react";

/** One install command, copied through the same control Settings → Browser uses. */
function CommandRow({ command, note }: { command: string; note: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <CopyCommand command={command} />
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{note}</span>
    </div>
  );
}

export function InstallPrompt({
  mode,
  onRetry,
}: {
  readonly mode: BrowserState["mode"];
  readonly onRetry: () => void;
}) {
  const commands = installCommands(mode);
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Globe variant="bold" />
        </EmptyMedia>
        <EmptyTitle>The browser tool is not installed</EmptyTitle>
        <EmptyDescription>
          The agent drives the browser through <code className="font-mono">agent-browser</code>.{" "}
          {commands.length === 1 ? "Run this command" : "Run these commands"}, then try again.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-md items-stretch">
        {commands.map((entry) => (
          <CommandRow key={entry.command} command={entry.command} note={entry.note} />
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </EmptyContent>
    </Empty>
  );
}

/**
 * What `/` shows with nothing to start a thread on: no server, or a server
 * with no projects yet. A fresh install lands here with no projects, so the
 * empty state carries the same Add project dialog the sidebar does — without
 * it the screen would be an input with nowhere to send it.
 *
 * The header above it holds only the window chrome while the sidebar is
 * hidden (`StartThreadHeader` with no controls): there is no project for the
 * git actions, the terminal or the dock to act on.
 */

import { cn } from "@poseidon/ui/lib/utils";
import { AddProjectDialog } from "@/components/sidebar/add-project-dialog";
import { StartThreadHeader } from "@/components/thread/start-thread-header";
import { useChatWidth } from "@/lib/use-chat-width";

export function StartThreadEmpty({
  connected,
  empty,
}: {
  readonly connected: boolean;
  /** Connected, with no projects at all. */
  readonly empty: boolean;
}) {
  const chatWidth = useChatWidth();
  return (
    <>
      <StartThreadHeader controls={null} />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-10 py-6">
        <div
          className={cn(
            "flex w-full flex-col items-center gap-5 text-center",
            chatWidth.classes.column,
          )}
        >
          <div className="flex flex-col gap-1.5">
            <h1 className="text-base font-medium text-foreground">
              {empty ? "No projects yet" : "Start a thread"}
            </h1>
            <p className="type-body text-muted-foreground">
              {!connected
                ? "No server is connected, so there is nothing to start a thread on yet."
                : "A thread belongs to a project — a directory on this machine the agent works in. Add one to start."}
            </p>
          </div>
          {empty ? <AddProjectDialog trigger="button" /> : null}
        </div>
      </div>
    </>
  );
}

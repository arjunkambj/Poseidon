/**
 * The in-window half of the desktop quit guard (apps/desktop/src/main/
 * quitGuard.ts). The shell holds a quit while threads are running or waiting
 * on the user and asks here; this lists them with their sidebar marks and
 * answers: "Quit anyway" quits, Cancel or dismissing keeps the app open. A
 * second Cmd+Q while this is open is the shell's to pass straight through.
 * In a plain browser no request ever arrives.
 */

import { cn } from "@poseidon/ui/lib/utils";
import * as React from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { threadStatusMark } from "@/components/sidebar/thread-status";
import { busyThreads } from "@/lib/attention";
import { answerQuit, onQuitRequest } from "@/lib/desktop-attention";
import { useLoadedThreadList } from "@/state/hooks";

export function QuitGuardDialog() {
  const [open, setOpen] = React.useState(false);
  const confirmed = React.useRef(false);
  const busy = busyThreads(useLoadedThreadList() ?? []);

  React.useEffect(
    () =>
      onQuitRequest(() => {
        confirmed.current = false;
        setOpen(true);
      }),
    [],
  );

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) return;
    // ConfirmDialog closes before it confirms, in the same click: wait for
    // that click to finish before reading a close as Cancel.
    queueMicrotask(() => {
      if (!confirmed.current) answerQuit(false);
    });
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Quit while agents are working?"
      description={
        <span className="flex flex-col gap-2">
          <span>Quitting stops these threads where they are.</span>
          <span className="flex flex-col">
            {busy.map((thread) => {
              const mark = threadStatusMark(thread);
              const Icon = mark?.icon;
              return (
                <span
                  key={thread.threadId}
                  className="flex h-7 items-center gap-2 px-2 py-1 text-foreground"
                >
                  {Icon === undefined ? null : (
                    <Icon
                      variant="bold"
                      aria-label={mark?.label}
                      className={cn("size-4 shrink-0", mark?.tone)}
                    />
                  )}
                  <span className="truncate">{thread.title}</span>
                </span>
              );
            })}
          </span>
        </span>
      }
      confirmLabel="Quit anyway"
      onConfirm={() => {
        confirmed.current = true;
        answerQuit(true);
      }}
    />
  );
}

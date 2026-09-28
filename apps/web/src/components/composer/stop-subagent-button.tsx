/**
 * The agents strip's Stop: `thread.task.stop` for one running subagent. The
 * strip renders it only when the thread's session says its harness can stop
 * one (`capabilities.stopTask`). The harness settles the task row and the
 * turn goes on; the button stays disabled until the row stops being the one
 * the strip names, or the server refuses (a toast says why).
 */

import type { ItemId, ThreadId } from "@poseidon/contracts/ids";
import { Button } from "@poseidon/ui/components/button";
import * as React from "react";

import { threadCommandBase, useThreadCommand } from "@/components/sidebar/thread-actions";

export function StopSubagentButton({
  threadId,
  itemId,
}: {
  readonly threadId: ThreadId;
  readonly itemId: ItemId;
}) {
  const send = useThreadCommand();
  const [stopping, setStopping] = React.useState<ItemId | null>(null);
  const stop = () => {
    setStopping(itemId);
    const command = { ...threadCommandBase(threadId), type: "thread.task.stop" as const, itemId };
    void send(command, "The subagent could not be stopped").then((accepted) => {
      if (!accepted) setStopping(null);
    });
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="shrink-0"
      disabled={stopping === itemId}
      onClick={stop}
    >
      Stop
    </Button>
  );
}

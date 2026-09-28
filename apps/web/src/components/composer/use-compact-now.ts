/**
 * Starting a `/compact` turn from the context meter or the slash menu.
 *
 * Not `useSendDraft`: that stages the composer's attachments and clears the
 * draft on success, and compacting must leave whatever the user is typing
 * alone. The command is the one a typed `/compact` would dispatch — a
 * `thread.turn.start` with no attachments or mentions — so the harness sees
 * no difference. One dispatch at a time, latched by a ref as well as state,
 * like the send button.
 */

import { useAtomSet } from "@effect/atom-react";
import { makeCommandId } from "@poseidon/contracts/ids";
import type { ThreadId } from "@poseidon/contracts/ids";
import * as React from "react";

import { COMPACT_COMMAND } from "@/components/composer/compact-now";
import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { noteLocalSend } from "@/state/local-sends";

export interface CompactNow {
  /** The dispatch has not answered yet. */
  readonly compacting: boolean;
  readonly compact: () => void;
  /** Why the last attempt failed; cleared by the next one. */
  readonly error: string | null;
}

export function useCompactNow(threadId: ThreadId): CompactNow {
  const { dispatchAtom } = useClientRuntime();
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });
  const [compacting, setCompacting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const compactingRef = React.useRef(false);

  const compact = React.useCallback(() => {
    if (compactingRef.current) {
      return;
    }
    compactingRef.current = true;
    setCompacting(true);
    setError(null);
    // Before the dispatch: the message row can arrive before the receipt.
    noteLocalSend(threadId);
    void dispatch({
      commandId: makeCommandId(),
      createdAt: new Date().toISOString(),
      type: "thread.turn.start",
      threadId,
      text: COMPACT_COMMAND,
      attachments: [],
      mentions: [],
      queued: false,
    })
      .then(
        (receipt) => setError(receiptError(receipt, "the server rejected the compaction")),
        () => setError(DISPATCH_UNREACHABLE),
      )
      .finally(() => {
        compactingRef.current = false;
        setCompacting(false);
      });
  }, [dispatch, threadId]);

  return { compacting, compact, error };
}

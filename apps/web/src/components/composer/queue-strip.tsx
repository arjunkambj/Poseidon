/**
 * The queued-message strip. `doc.queue` is a server projection — entries land
 * via `thread.message.queued` and leave via `thread.message.dequeued`, either
 * because the next turn consumed one or because the user took it back with
 * `thread.queue.remove`. Nothing is removed locally: the row disappears when
 * the event lands, so the strip never disagrees with the server about what is
 * still going to be sent.
 *
 * Reordering goes the same way: `thread.queue.reorder` names the message and
 * the position it should end up in, and the strip redraws when
 * `thread.queue.reordered` lands. Buttons rather than a drag handle — the list
 * is short, and up/down works with a keyboard and a screen reader.
 *
 * Each row's "…" menu (`./queue-row-menu`) steers it into the running turn,
 * takes it back into the composer, or removes it; the commands behind those
 * live in `./use-queue-actions`.
 */

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type { ThreadId } from "@poseidon/contracts/ids";
import type { QueuedMessage } from "@poseidon/contracts/orchestration";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { QueueRowMenu } from "@/components/composer/queue-row-menu";
import { queueSummary } from "@/components/composer/queue-summary";
import { useQueueActions } from "@/components/composer/use-queue-actions";
import { ChevronDown, ChevronUp, ListOrdered } from "@honeyicons/react";

/** What a queued message carries besides its text, or nothing. */
function QueuedMessageSummary({ message }: { readonly message: QueuedMessage }) {
  const summary = queueSummary(message);
  return summary === null ? null : (
    <span className="shrink-0 text-xs text-muted-foreground">{summary}</span>
  );
}

export function QueueStrip({
  threadId,
  queue,
  steerable,
}: {
  readonly threadId: ThreadId;
  readonly queue: ReadonlyArray<QueuedMessage>;
  /** A turn is running on a session that steers: rows offer "Steer now". */
  readonly steerable: boolean;
}) {
  const actions = useQueueActions(threadId);
  const { busy, error } = actions;

  if (queue.length === 0) {
    return null;
  }
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-1 rounded-xl bg-card px-3 py-2"
      aria-label="Queued messages"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ListOrdered variant="bold" className="size-3.5" />
        <span>
          {queue.length} queued {queue.length === 1 ? "message" : "messages"} — sent in order when
          the turn ends
        </span>
      </div>
      <ol className="flex min-w-0 flex-col">
        {queue.map((message, index) => (
          <li key={message.queuedMessageId} className="flex min-w-0 items-center gap-2 text-sm">
            <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate">{message.text}</span>
            <QueuedMessageSummary message={message} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    tone="muted"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={`Move queued message ${index + 1} up`}
                    disabled={busy !== null || index === 0}
                    onClick={() => actions.move(message, index - 1)}
                  />
                }
              >
                <ChevronUp variant="bold" />
              </TooltipTrigger>
              <TooltipContent>Send this one sooner</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    tone="muted"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={`Move queued message ${index + 1} down`}
                    disabled={busy !== null || index === queue.length - 1}
                    onClick={() => actions.move(message, index + 1)}
                  />
                }
              >
                <ChevronDown variant="bold" />
              </TooltipTrigger>
              <TooltipContent>Send this one later</TooltipContent>
            </Tooltip>
            <QueueRowMenu
              position={index + 1}
              message={message}
              steerable={steerable}
              disabled={busy !== null}
              onAction={(action) => actions[action](message)}
            />
          </li>
        ))}
      </ol>
      {error === null ? null : (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={queue.some(
          (message) => message.queuedMessageId === actions.pendingEdit?.queuedMessageId,
        )}
        onOpenChange={(open) => {
          if (!open) {
            actions.cancelEdit();
          }
        }}
        title="Replace your draft?"
        description="The queued message takes the draft's place in the composer. What you have typed there is discarded."
        confirmLabel="Replace draft"
        onConfirm={actions.confirmEdit}
      />
    </div>
  );
}

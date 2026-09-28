/**
 * The actions under a message. The `user` variant sits right-aligned under
 * the bubble: when it was sent, Copy, "Restore to here" and "Fork from here"
 * (`./fork-from-message`). The `agent`
 * variant sits left-aligned under the final answer of a settled turn: Copy,
 * when the answer began, and how long the turn took.
 *
 * - The time comes from the item's UUIDv7 id — the moment the server recorded
 *   the message — shown as "14:05" with the full date in its tooltip. The
 *   time and the duration take keyboard focus, so their tooltips do not need
 *   a mouse, and name themselves with the same words.
 * - Copy copies the text exactly as typed, markdown and all — for an answer,
 *   its markdown source.
 * - The turn's duration is the fold's (`TurnEnd`): its first item to when it
 *   ended (its checkpoint), else to its last item's start — the span the
 *   turn's fold row reports. No model is named: the thread's
 *   settings say which model runs now, not which one ran that turn.
 * - Restore to here puts the workspace back to how it was before the message
 *   was sent (`RestoreBeforeTurn`): the checkpoint of the turn before this
 *   message's turn, through the restore dialog. A message steered into a
 *   running turn has no checkpoint of its own to go back to, only the one
 *   before that turn began, and its tooltip and dialog say so. It is left out where there is
 *   nothing to restore, and disabled, saying why, while no restore can start.
 *
 * The row reveals the footer on hover and while focus is inside it, and a
 * coarse pointer (touch) always shows it, since there is no hover to find it
 * with. Only its opacity changes: the footer always takes its height, so a
 * hover never reflows the row the virtualizer has measured.
 *
 * The caller keys it by item id. The copy tick and the dialog's open state are
 * component state, and a recycled row must not inherit them.
 */

import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import { uuidV7Millis } from "@poseidon/shared/ids";
import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { CopyButton } from "@/components/copy-button";
import { ForkFromMessage } from "@/components/timeline/fork-from-message";
import { RestoreBeforeTurn } from "@/components/timeline/restore-before-turn";
import { formatClock, formatDurationMs, formatFullDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Undo } from "@honeyicons/react";

// The time and the duration are focus stops of their own, so the tooltip that
// says more reaches the keyboard too; their names carry the same words for a
// screen reader.
const FOCUSABLE_TEXT =
  "rounded-sm px-1 type-micro text-muted-foreground tabular-nums outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

function SentAt({ ms }: { readonly ms: number }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            dateTime={new Date(ms).toISOString()}
            tabIndex={0}
            aria-label={formatFullDate(ms)}
            className={FOCUSABLE_TEXT}
          />
        }
      >
        {formatClock(ms)}
      </TooltipTrigger>
      <TooltipContent>{formatFullDate(ms)}</TooltipContent>
    </Tooltip>
  );
}

const RESTORE_TAIL =
  "Every tracked file returns to that checkpoint and files created since are removed. Uncommitted work that is not in a checkpoint is lost. The conversation stays as it is.";

/**
 * A message that opened its turn restores to just before it was sent. One
 * steered into a turn already running shares that turn's checkpoint, the one
 * from before the turn began, so its copy says what else that undoes.
 */
const RESTORE_COPY = {
  opener: {
    tooltip: "Restore to here",
    title: "Restore to before this message?",
    description: `The workspace goes back to how it was before this message was sent. ${RESTORE_TAIL}`,
    label: "Restore the workspace to before this message",
    skippedNote:
      "The turn right before this message has no checkpoint, so this goes back to an earlier one and undoes that turn's changes too.",
  },
  steered: {
    tooltip: "Restore to before this turn",
    title: "Restore to before this turn?",
    description: `This message joined a turn that was already running, so the workspace goes back to how it was before that turn began: what the turn changed before this message arrived is undone too. ${RESTORE_TAIL}`,
    label: "Restore the workspace to before the turn this message joined",
    skippedNote:
      "The turn before the one this message joined has no checkpoint, so this goes back to an earlier one and undoes that turn's changes too.",
  },
} as const;

function RestoreToHere({
  item,
  steered,
}: {
  readonly item: ItemSnapshot;
  readonly steered: boolean;
}) {
  const copy = RESTORE_COPY[steered ? "steered" : "opener"];
  return (
    <RestoreBeforeTurn
      turnId={item.turnId}
      tooltip={copy.tooltip}
      title={copy.title}
      description={copy.description}
      skippedNote={copy.skippedNote}
      renderButton={(props) => (
        <Button
          type="button"
          variant="ghost"
          tone="muted"
          size="icon-xs"
          aria-label={copy.label}
          {...props}
        >
          <Undo variant="bold" />
        </Button>
      )}
    />
  );
}

function TurnDuration({ ms }: { readonly ms: number }) {
  const duration = formatDurationMs(ms);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span tabIndex={0} aria-label={`The turn took ${duration}`} className={FOCUSABLE_TEXT} />
        }
      >
        {duration}
      </TooltipTrigger>
      <TooltipContent>{`The turn took ${duration}`}</TooltipContent>
    </Tooltip>
  );
}

// Opacity only: the footer keeps its height, so a hover never reflows the row.
const REVEAL =
  "flex items-center gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-hover/message:opacity-100 group-focus-within/message:opacity-100 pointer-coarse:opacity-100 has-data-popup-open:opacity-100 motion-reduce:transition-none";

type MessageFooterProps =
  | {
      readonly item: ItemSnapshot;
      readonly variant?: "user";
      /** Steered into a running turn: Restore goes back to before that turn. */
      readonly steered?: boolean;
    }
  | {
      readonly item: ItemSnapshot;
      readonly variant: "agent";
      /** How long the turn the answer ends took; nothing is shown when unknown. */
      readonly durationMs: number | undefined;
    };

export function MessageFooter(props: MessageFooterProps) {
  const { item } = props;
  const sentAt = uuidV7Millis(item.itemId);
  if (props.variant === "agent") {
    return (
      <div data-slot="message-footer" className={cn(REVEAL, "justify-start")}>
        <CopyButton
          text={item.text ?? ""}
          label="Copy answer"
          tooltip="Copy markdown"
          tone="muted"
        />
        {sentAt === undefined ? null : <SentAt ms={sentAt} />}
        {props.durationMs === undefined || props.durationMs <= 0 ? null : (
          <TurnDuration ms={props.durationMs} />
        )}
      </div>
    );
  }
  return (
    <div data-slot="message-footer" className={cn(REVEAL, "justify-end")}>
      {sentAt === undefined ? null : <SentAt ms={sentAt} />}
      <CopyButton text={item.text ?? ""} label="Copy message" tone="muted" />
      <RestoreToHere item={item} steered={props.steered === true} />
      <ForkFromMessage item={item} />
    </div>
  );
}

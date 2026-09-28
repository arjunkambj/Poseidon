/**
 * The composer's bottom row: attach button, the steering notice, Stop, and
 * the send button — which, like Enter, steers the running turn when the
 * harness can take a message mid-turn and shows the queue glyph while a turn
 * runs otherwise. The queue chord still queues.
 *
 * Stop only exists while a turn is running and is the visible half of the
 * `thread.interrupt` binding: a user who never learns the chord still has a
 * way to end a turn that is going wrong.
 *
 * The row is its own size container. `settings` renders `contents`, so its
 * pickers sit in this row as flex items: wide, model and effort sit beside
 * Send, with the context meter between them and it; below `@xl/toolbar` the
 * pair drops to a line of its own under the row (`order-3 basis-full`, see
 * `../header-controls`) instead of wrapping inside itself.
 *
 * Attach is disabled, with the reason as its tooltip, when the thread's
 * connector cannot take attachments (`@/lib/attachment-support`). The file
 * input's ref is the caller's, so the `composer.attach` key can open the same
 * chooser (`./use-composer-commands`).
 */

import { Button } from "@poseidon/ui/components/button";
import { Kbd } from "@poseidon/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import type * as React from "react";

import { ATTACHMENT_ACCEPT } from "@/components/composer/attachment-rules";
import { CommandKbd } from "@/lib/shortcuts";

import { Add, ListOrdered, Send, Spinner, Stop as StopIcon } from "@honeyicons/react";

export function ComposerToolbar({
  settings,
  running,
  steerable,
  canSend,
  interrupting,
  sending,
  filesKey,
  fileInputRef,
  onFilesPicked,
  onSend,
  onInterrupt,
  attachDisabledReason,
  sendMenu,
}: {
  readonly settings?: React.ReactNode;
  readonly running: boolean;
  /** A turn runs and its harness takes messages into it: sending steers. */
  readonly steerable: boolean;
  readonly canSend: boolean;
  /** An interrupt is in flight — the turn has not settled yet. */
  readonly interrupting: boolean;
  /** A message is on its way out — the button stays down until it lands. */
  readonly sending: boolean;
  /** Remounts the file input when the attachment list resets, clearing it. */
  readonly filesKey: number;
  readonly fileInputRef: React.RefObject<HTMLInputElement | null>;
  readonly onFilesPicked: (files: ReadonlyArray<File>) => void;
  readonly onSend: () => void;
  readonly onInterrupt: () => void;
  /** Why attaching is refused; the button is disabled when it is set. */
  readonly attachDisabledReason?: string;
  /** More ways to send, right after the send button (New task's "Start in background"). */
  readonly sendMenu?: React.ReactNode;
}) {
  const attachDisabled = attachDisabledReason !== undefined;
  return (
    <div className="@container/toolbar min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-2">
        <input
          key={filesKey}
          ref={fileInputRef}
          type="file"
          hidden
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={(event) => {
            onFilesPicked([...(event.target.files ?? [])]);
            // Emptied on the way out, not only when the list resets: a file the
            // rules refused leaves the list unchanged, so without this the same
            // file picked twice fires no `change` the second time and the user
            // gets no answer at all.
            event.target.value = "";
          }}
        />
        {/* The trigger wraps the button rather than being it: a disabled button
          takes no pointer events, and the tooltip is where a refused attach
          says why. */}
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              type="button"
              variant="ghost"
              tone="muted"
              size="icon-sm"
              aria-label="Attach files"
              disabled={attachDisabled}
              onClick={() => fileInputRef.current?.click()}
            >
              <Add variant="bold" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {attachDisabledReason ?? (
              <>
                Attach files
                <CommandKbd command="composer.attach" />
              </>
            )}
          </TooltipContent>
        </Tooltip>
        {settings}
        <span aria-hidden className="flex-1" />
        {steerable ? (
          <span className="order-2 text-xs text-muted-foreground">Steering the running turn</span>
        ) : null}
        {running ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-sm"
                  shape="pill"
                  className="order-2 ml-1 shrink-0"
                  aria-label="Stop turn"
                  disabled={interrupting}
                  onClick={onInterrupt}
                />
              }
            >
              {interrupting ? <Spinner variant="bold" /> : <StopIcon variant="bold" />}
            </TooltipTrigger>
            <TooltipContent>
              Stop turn
              <CommandKbd command="thread.interrupt" />
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                shape="pill"
                className="order-2 ml-1 shrink-0"
                aria-label={steerable ? "Steer turn" : running ? "Queue message" : "Send message"}
                disabled={!canSend || sending}
                onClick={onSend}
              />
            }
          >
            {sending ? (
              <Spinner variant="bold" />
            ) : running && !steerable ? (
              <ListOrdered variant="bold" />
            ) : (
              <Send variant="bold" />
            )}
          </TooltipTrigger>
          <TooltipContent>
            {steerable ? (
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5">
                  Send to the running turn<Kbd>↵</Kbd>
                </span>
                <span className="flex items-center gap-1.5">
                  Queue instead
                  <CommandKbd command="composer.queue" />
                </span>
              </span>
            ) : running ? (
              <>
                Queue message
                <CommandKbd command="composer.queue" />
              </>
            ) : (
              <>
                Send<Kbd>↵</Kbd>
              </>
            )}
          </TooltipContent>
        </Tooltip>
        {sendMenu}
      </div>
    </div>
  );
}

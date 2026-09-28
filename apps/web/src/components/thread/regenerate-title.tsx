/**
 * Regenerate title: asks the server to write a new title for a thread from
 * the end of its conversation (`thread.regenerateTitle`), which it applies
 * with `thread.rename` itself, so the sidebar and the header follow on their
 * own. Offered in the sidebar row's menu and, for the open thread, as the
 * palette command `thread.regenerateTitle` (no default chord) — the thread
 * header has no menu of its own.
 *
 * One toast per run: "Writing a new title…", replaced in place by the new
 * title or the server's reason. A second request for a thread whose title is
 * still being written is ignored. Both entry points are off while the server
 * is out of reach or no harness can write text (`generationBlockedReason`):
 * the menu item is disabled with a short hint, and the palette does not offer
 * the command at all.
 */

import type { ThreadId } from "@poseidon/contracts/ids";
import { toast } from "sonner";

import { GENERATION_OFFLINE, type GenerationOutcome } from "@/lib/generation-run";
import { useKeybindingCommand } from "@/lib/shortcuts";
import {
  showGenerationNotice,
  useGenerationBlockedReason,
  useGenerationCommands,
} from "@/lib/use-generation";

const writing = new Set<ThreadId>();

export interface TitleToasts {
  readonly loading: (message: string, options: { readonly id: string }) => void;
  readonly success: (message: string, options: { readonly id: string }) => void;
  readonly error: (message: string, options: { readonly id: string }) => void;
}

/** One regeneration with its toast; nothing while one runs for the same thread. */
export const regenerateTitleFor = async (
  threadId: ThreadId,
  deps: {
    readonly regenerate: (
      threadId: ThreadId,
    ) => Promise<
      GenerationOutcome<{ readonly title: string; readonly notice?: string | undefined }>
    >;
    readonly toasts: TitleToasts;
    readonly notice: (notice: string | undefined) => void;
  },
): Promise<void> => {
  if (writing.has(threadId)) {
    return;
  }
  writing.add(threadId);
  const id = `regenerate-title-${threadId}`;
  deps.toasts.loading("Writing a new title…", { id });
  try {
    const outcome = await deps.regenerate(threadId);
    if (outcome.ok) {
      deps.toasts.success(`Renamed to “${outcome.value.title}”`, { id });
      deps.notice(outcome.value.notice);
    } else {
      deps.toasts.error(`Couldn't regenerate the title: ${outcome.message}`, { id });
    }
  } finally {
    writing.delete(threadId);
  }
};

/** The menu item's hint for why it is disabled. */
export const regenerateTitleHint = (reason: string | null): string | null =>
  reason === null ? null : reason === GENERATION_OFFLINE ? "Offline" : "Unavailable";

/** `reason` is why nothing can write now (`null` when something can); `regenerate` runs one. */
export const useRegenerateTitle = () => {
  const reason = useGenerationBlockedReason();
  const { regenerateTitle } = useGenerationCommands();
  return {
    reason,
    regenerate: (threadId: ThreadId) =>
      void regenerateTitleFor(threadId, {
        regenerate: (id) => regenerateTitle({ threadId: id }),
        toasts: toast,
        notice: showGenerationNotice,
      }),
  };
};

/**
 * `thread.regenerateTitle` for the open thread. Mounted only while it can
 * run, so the palette offers it exactly then.
 */
function RegenerateTitleCommand({ onRun }: { readonly onRun: () => void }) {
  useKeybindingCommand("thread.regenerateTitle", onRun);
  return null;
}

/** The palette's Regenerate title for the open thread; nothing while it cannot run. */
export function RegenerateTitleShortcut({ threadId }: { readonly threadId: ThreadId }) {
  const { reason, regenerate } = useRegenerateTitle();
  return reason === null ? <RegenerateTitleCommand onRun={() => regenerate(threadId)} /> : null;
}

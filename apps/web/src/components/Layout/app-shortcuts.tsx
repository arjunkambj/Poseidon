/**
 * The thread-switching and history keys, which work from any route — so this
 * is mounted once at the root, inside `KeybindingsProvider`, beside the
 * palette's own route-independent commands.
 *
 * - `nav.back` / `nav.forward` walk the router's history, as the chrome's
 *   back and forward buttons do. Back does nothing at the start of the stack.
 * - `thread.jump.1`…`9` open the Nth thread in sidebar order and
 *   `thread.previous` / `thread.next` step through it with wrap; with no
 *   thread open they start from the last or the first. The order is the
 *   tree's own (`useThreadTargets`), folded projects and all, so the Nth
 *   thread is the Nth row on screen — and the palette's thread rows show the
 *   same numbers.
 * - `thread.newInProject` starts a thread in the open thread's project, else
 *   the last project used, else the first, through the one create flow.
 * - `font.increase` / `font.decrease` / `font.reset` step the main and sidebar
 *   text sizes together, through the same settings write as the Appearance
 *   steppers (`useFontSizes`). Their chords carry Alt (`Mod+Alt+=` and so on)
 *   because the Electron default menu keeps `Mod+=`/`-`/`0` for page zoom.
 * - `chatWidth.cycle` steps the chat width (Comfortable, Wide, Full, and round
 *   again) through the same settings write as the General page toggle. It has
 *   no default chord; the palette and the cheatsheet list it, and it can be bound.
 *
 * A command is claimed only while it has something to act on — no threads, no
 * stepping; no project, no new thread; no settings yet, no font or width steps — so the palette never offers a row
 * that does nothing. The numbered jumps stay claimed and a number past the end
 * does nothing; the palette shows each one on its thread's row instead of
 * listing it as a command.
 */

import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import * as React from "react";

import { THREAD_JUMP_COMMANDS } from "@poseidon/contracts/keybindings";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";
import type { ChatWidth } from "@poseidon/contracts/settings";

import { neighbourThread, nthThread } from "@/components/sidebar/thread-order";
import { useThreadTargets } from "@/components/sidebar/use-thread-targets";
import { nextChatWidth } from "@/lib/chat-width";
import { stepFontSizes, type FontSizes } from "@/lib/font-size";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { useChatWidth } from "@/lib/use-chat-width";
import { useFontSizes } from "@/lib/use-font-sizes";
import { useCreateThread } from "@/lib/use-create-thread";

type OpenThread = (threadId: ThreadId) => void;

function HistoryShortcuts() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  useKeybindingCommand("nav.back", () => {
    if (canGoBack) {
      router.history.back();
    }
  });
  useKeybindingCommand("nav.forward", () => router.history.forward());
  return null;
}

function ThreadJumpShortcut({
  command,
  n,
  order,
  open,
}: {
  readonly command: string;
  readonly n: number;
  readonly order: ReadonlyArray<ThreadSummary>;
  readonly open: OpenThread;
}) {
  useKeybindingCommand(command, () => {
    const target = nthThread(order, n);
    if (target !== undefined) {
      open(target.threadId);
    }
  });
  return null;
}

function ThreadStepShortcuts({
  order,
  openThreadId,
  open,
}: {
  readonly order: ReadonlyArray<ThreadSummary>;
  readonly openThreadId: string | null;
  readonly open: OpenThread;
}) {
  const step = (by: 1 | -1) => {
    const target = neighbourThread(order, openThreadId, by);
    if (target !== undefined && target.threadId !== openThreadId) {
      open(target.threadId);
    }
  };
  useKeybindingCommand("thread.previous", () => step(-1));
  useKeybindingCommand("thread.next", () => step(1));
  return null;
}

function NewInProjectShortcut({ projectId }: { readonly projectId: ProjectId }) {
  const { create, pending } = useCreateThread();
  useKeybindingCommand("thread.newInProject", () => {
    if (!pending) {
      void create(projectId);
    }
  });
  return null;
}

function FontShortcuts({
  sizes,
  setSizes,
}: {
  readonly sizes: FontSizes;
  readonly setSizes: (next: FontSizes) => void;
}) {
  const step = (direction: 1 | -1 | "reset") => {
    const next = stepFontSizes(sizes, direction);
    if (next.main !== sizes.main || next.sidebar !== sizes.sidebar) {
      setSizes(next);
    }
  };
  useKeybindingCommand("font.increase", () => step(1));
  useKeybindingCommand("font.decrease", () => step(-1));
  useKeybindingCommand("font.reset", () => step("reset"));
  return null;
}

function ChatWidthShortcut({
  width,
  setWidth,
}: {
  readonly width: ChatWidth;
  readonly setWidth: (next: ChatWidth) => void;
}) {
  useKeybindingCommand("chatWidth.cycle", () => setWidth(nextChatWidth(width)));
  return null;
}

export function AppShortcuts() {
  const navigate = useNavigate();
  const { order, openThreadId, newThreadProject } = useThreadTargets();
  const { sizes, setSizes } = useFontSizes();
  const chatWidth = useChatWidth();

  const open = React.useCallback<OpenThread>(
    (threadId) => void navigate({ to: "/t/$threadId", params: { threadId } }),
    [navigate],
  );

  return (
    <>
      <HistoryShortcuts />
      {THREAD_JUMP_COMMANDS.map((command, index) => (
        <ThreadJumpShortcut
          key={command}
          command={command}
          n={index + 1}
          order={order}
          open={open}
        />
      ))}
      {order.length > 0 ? (
        <ThreadStepShortcuts order={order} openThreadId={openThreadId} open={open} />
      ) : null}
      {newThreadProject === undefined ? null : (
        <NewInProjectShortcut projectId={newThreadProject.projectId} />
      )}
      {sizes === null ? null : <FontShortcuts sizes={sizes} setSizes={setSizes} />}
      {chatWidth.loaded ? (
        <ChatWidthShortcut width={chatWidth.width} setWidth={chatWidth.setWidth} />
      ) : null}
    </>
  );
}

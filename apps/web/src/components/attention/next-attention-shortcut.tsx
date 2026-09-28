/**
 * `thread.nextAttention`: open the freshest thread that needs you (an
 * approval, a question, a ready plan), else the freshest unread one
 * (`nextAttentionThread`, @/lib/attention). Mounted once at the root beside
 * the attention coordinator.
 *
 * The command is claimed only while there is somewhere to go, like the
 * sidebar's thread steps, so the palette never offers a row that does
 * nothing.
 */

import { useMatchRoute, useNavigate } from "@tanstack/react-router";

import type { ThreadId } from "@poseidon/contracts/ids";

import { useThreadSeen } from "@/components/sidebar/thread-seen";
import { nextAttentionThread } from "@/lib/attention";
import { useKeybindingCommand } from "@/lib/shortcuts";
import { useLoadedThreadList } from "@/state/hooks";

function NextAttentionCommand({ threadId }: { readonly threadId: ThreadId }) {
  const navigate = useNavigate();
  useKeybindingCommand(
    "thread.nextAttention",
    () => void navigate({ to: "/t/$threadId", params: { threadId } }),
  );
  return null;
}

export function NextAttentionShortcut() {
  const list = useLoadedThreadList();
  const [seen] = useThreadSeen();
  const openRoute = useMatchRoute()({ to: "/t/$threadId" });
  const openThreadId = openRoute === false ? null : openRoute.threadId;
  const target = list === null ? undefined : nextAttentionThread(list, seen, openThreadId);
  return target === undefined ? null : <NextAttentionCommand threadId={target.threadId} />;
}

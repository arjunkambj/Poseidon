import { createFileRoute, notFound } from "@tanstack/react-router";

import { decodeThreadId } from "@poseidon/contracts/ids";

import { isDockPane, type DockPane } from "@/components/dock/dock-toggle";
import { parseChangesLink, type ChangesLink } from "@/components/panes/changes/deep-link";
import { ThreadView } from "@/components/thread/thread-view";

export const Route = createFileRoute("/_home/t/$threadId")({
  params: {
    // The id arrives as a raw string; anything that is not a UUIDv7 is a 404,
    // not a subscription.
    parse: (params) => {
      try {
        return { threadId: decodeThreadId(params.threadId) };
      } catch {
        throw notFound();
      }
    },
  },
  // `pane` is optional on purpose: links that never mention the dock keep
  // working, and `?pane=` is only present while the dock is open — on a tab,
  // or `home` for its launcher. Anything else reads as a closed dock. `turn`,
  // `file` and `line` are a link into the Changes pane, kept only beside
  // `pane=changes`; the pane clears them once it has acted on them
  // (`panes/changes/deep-link.ts`).
  validateSearch: (search): { pane?: DockPane } & ChangesLink => {
    const pane = isDockPane(search.pane) ? search.pane : undefined;
    return { pane, ...(pane === "changes" ? parseChangesLink(search) : {}) };
  },
  component: ThreadPage,
});

function ThreadPage() {
  const { threadId } = Route.useParams();
  const { pane } = Route.useSearch();
  return <ThreadView threadId={threadId} dockTab={pane} />;
}

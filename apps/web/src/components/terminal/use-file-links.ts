/**
 * The handlers behind a terminal's file links (`./file-link-provider`), for
 * the drawer's owner: a thread's, or the project's own on the New task page.
 *
 * `resolve` asks `files.stat` in the owner's root — the thread's workspace, or
 * the project's folder — where a relative path resolves against the root and
 * an absolute one counts only inside it. `activate` does what `fileLinkAction`
 * picks: the owner's Files tab at the line (`@/state/file-reveal`, keyed by
 * `workspaceKey`, which the thread view — or the New task page, for the
 * project — answers by opening the dock on Files), or the favourite editor at
 * the line through `editors.open`, toasting a refusal.
 */

import { detectModKey } from "@poseidon/client-runtime/keybindings";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import * as Exit from "effect/Exit";
import * as React from "react";

import { useDetectedEditors } from "@/components/open-in/editor-atoms";
import { useFavouriteEditor, useOpenInWithToast } from "@/components/open-in/use-open-in";
import { useStatFiles } from "@/components/panes/files/file-atoms";
import type { FileLinkHandlers } from "@/components/terminal/file-link-provider";
import { fileLinkAction } from "@/components/terminal/file-links";
import { workspaceKey } from "@/lib/workspace-key";
import { useRequestFileReveal } from "@/state/file-reveal";

export function useFileLinks(scope: {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
}): FileLinkHandlers {
  const { projectId, threadId } = scope;
  const statFiles = useStatFiles();
  const requestReveal = useRequestFileReveal();
  const { favourite } = useFavouriteEditor(useDetectedEditors());
  const openIn = useOpenInWithToast();

  const resolve = React.useCallback<FileLinkHandlers["resolve"]>(
    async (paths) => {
      const exit = await statFiles({
        projectId,
        ...(threadId === undefined ? {} : { threadId }),
        paths,
      });
      if (Exit.isSuccess(exit)) return exit.value;
      throw new Error("files.stat failed");
    },
    [projectId, statFiles, threadId],
  );

  const activate = React.useCallback<FileLinkHandlers["activate"]>(
    (stat, reference, event) => {
      const action = fileLinkAction(event, detectModKey(), { hasEditor: favourite !== null });
      if (action === "files") {
        requestReveal(workspaceKey({ projectId, threadId }), {
          path: stat.relativePath,
          line: reference.line,
        });
      } else if (favourite !== null) {
        void openIn(favourite, {
          projectId,
          ...(threadId === undefined ? {} : { threadId }),
          path: stat.relativePath,
          line: reference.line,
        });
      }
    },
    [favourite, openIn, projectId, requestReveal, threadId],
  );

  return React.useMemo(() => ({ resolve, activate }), [resolve, activate]);
}

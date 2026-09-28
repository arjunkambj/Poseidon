/**
 * The thread header's "Open in" split button: the main half opens the
 * thread's workspace — its worktree, when it has one — in the favourite
 * editor, and the chevron lists every editor the server detected, then the
 * file manager and the terminal.
 *
 * Picking an editor from the chevron opens it and makes it the favourite
 * (`preferredEditor` in the settings document, `./use-open-in`), so the main
 * half and `Mod+O` follow the last choice across reloads. The file manager
 * and the terminal only open; they never become the main half. The server
 * picks the root from the thread and refuses an app it did not detect; a
 * refusal is a toast with its message.
 *
 * With no editor detected — only the file manager, or nothing while offline —
 * the control renders nothing, and `editor.openFavorite` goes unanswered, so
 * the palette leaves it out. Below `@lg` the header (a container, `header`)
 * has the main half drop its label for its icon and tooltip, like Commit.
 */

import type { DetectedEditor } from "@poseidon/contracts/editors";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import { Button } from "@poseidon/ui/components/button";
import { ButtonGroup } from "@poseidon/ui/components/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";

import { useKeybindingCommand } from "@/lib/shortcuts";

import { Check, ChevronDown, Code, FolderOpen, Terminal } from "@honeyicons/react";

import { useDetectedEditors } from "./editor-atoms";
import { editorsOnly, otherApps, showOpenIn } from "./favourite";
import { useFavouriteEditor, useOpenInWithToast } from "./use-open-in";

/** The icon a detected app is listed with; the editors share one. */
function AppIcon({ app }: { app: DetectedEditor }) {
  if (app.kind === "file-manager") return <FolderOpen variant="bold" />;
  if (app.kind === "terminal") return <Terminal variant="bold" />;
  return <Code variant="bold" />;
}

/**
 * The split button itself, given what to show: the favourite on the main
 * half, and every detected app in the chevron's menu. Kept apart from the
 * atoms so it renders from plain props.
 */
export function OpenInSplitButton({
  editors,
  favourite,
  onOpen,
  onPick,
}: {
  editors: ReadonlyArray<DetectedEditor>;
  favourite: DetectedEditor;
  /** Open the workspace in the favourite, from the main half or its key. */
  onOpen: () => void;
  /** Open the workspace in an app picked from the menu. */
  onPick: (app: DetectedEditor) => void;
}) {
  const others = otherApps(editors);
  return (
    <ButtonGroup className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onOpen}
              aria-label={`Open in ${favourite.label}`}
            />
          }
        >
          <AppIcon app={favourite} />
          {/* A narrow header keeps the branch name over this label. */}
          <span className="hidden @lg/header:inline">{favourite.label}</span>
        </TooltipTrigger>
        <TooltipContent>Open the workspace in {favourite.label}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Open in…" />
                }
              />
            }
          >
            <ChevronDown variant="bold" />
          </TooltipTrigger>
          <TooltipContent>Open in…</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Open in</DropdownMenuLabel>
            {editorsOnly(editors).map((editor) => (
              <DropdownMenuItem key={editor.id} onClick={() => onPick(editor)}>
                <AppIcon app={editor} />
                {editor.label}
                {editor.id === favourite.id ? (
                  <Check variant="bold" className="ml-auto" aria-label="Favourite" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          {others.length === 0 ? null : (
            <>
              <DropdownMenuSeparator />
              {others.map((app) => (
                <DropdownMenuItem key={app.id} onClick={() => onPick(app)}>
                  <AppIcon app={app} />
                  {app.label}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

/** The part mounted only once there is an editor, so the key is answered only then. */
function OpenInButtons({
  projectId,
  threadId,
  editors,
}: {
  projectId: ProjectId;
  threadId: ThreadId;
  editors: ReadonlyArray<DetectedEditor>;
}) {
  const { favourite, choose } = useFavouriteEditor(editors);
  const open = useOpenInWithToast();
  const openIn = (app: DetectedEditor) => void open(app, { projectId, threadId });

  useKeybindingCommand("editor.openFavorite", () => {
    if (favourite !== null) openIn(favourite);
  });

  if (favourite === null) return null;
  return (
    <OpenInSplitButton
      editors={editors}
      favourite={favourite}
      onOpen={() => openIn(favourite)}
      onPick={(app) => {
        choose(app);
        openIn(app);
      }}
    />
  );
}

export function OpenInControl({
  projectId,
  threadId,
}: {
  projectId: ProjectId;
  /** The thread whose workspace (its worktree, when it has one) is opened. */
  threadId: ThreadId;
}) {
  const editors = useDetectedEditors();
  if (!showOpenIn(editors)) return null;
  return <OpenInButtons projectId={projectId} threadId={threadId} editors={editors} />;
}

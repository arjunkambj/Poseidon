/**
 * A file's menu entries (`./file-menu`) as menu items, in two thin renderers
 * over the same list: `FileDropdownItems` for the Changes "…" menu and
 * `FileContextItems` for a right-click menu. Only the menu parts differ.
 *
 * Both are rendered as a menu's content, which unmounts on close, so the
 * editor list, the favourite and the draft are read only while a menu is
 * open — a list of rows reads none of them.
 *
 * Actions: the Files tab opens through the thread view's reveal request
 * (`useRequestFileReveal`), or the Files tab's own `onOpenInFiles`; the
 * editors and the file manager through `editors.open` in the pane's scope
 * (`./file-menu-scope`), with a toast when the server refuses; the paths
 * through `copyPath`; and "Add to chat" appends the path to the thread's or
 * draft's message, the way the browser pane brings a picked element in —
 * the person reads and sends it; nothing reaches the agent on its own.
 */

import type { DetectedEditor } from "@poseidon/contracts/editors";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@poseidon/ui/components/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@poseidon/ui/components/dropdown-menu";
import * as React from "react";
import { toast } from "sonner";

import { appendToDraft } from "@/components/panes/browser/page-to-chat";
import { copyPath } from "@/lib/copy-path";
import { useKeybindingDispatch } from "@/lib/shortcuts";
import { useRequestFileReveal } from "@/state/file-reveal";
import { useComposerDraft } from "@/state/ui";

import {
  Chat,
  Clipboard,
  Code,
  Copy,
  ExternalLink,
  File as FileIcon,
  FolderOpen,
} from "@honeyicons/react";

import { useDetectedEditors } from "./editor-atoms";
import { type FileMenuEntry, fileMenuEntries } from "./file-menu";
import { useFileMenuScope } from "./file-menu-scope";
import { useFavouriteEditor, useOpenInWithToast } from "./use-open-in";

interface MenuParts {
  readonly Item: React.ComponentType<{ onClick?: () => void; children?: React.ReactNode }>;
  readonly Sub: React.ComponentType<{ children?: React.ReactNode }>;
  readonly SubTrigger: React.ComponentType<{ children?: React.ReactNode }>;
  readonly SubContent: React.ComponentType<{ className?: string; children?: React.ReactNode }>;
  readonly Separator: React.ComponentType;
}

const DROPDOWN: MenuParts = {
  Item: DropdownMenuItem,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  Separator: DropdownMenuSeparator,
};

const CONTEXT: MenuParts = {
  Item: ContextMenuItem,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  Separator: ContextMenuSeparator,
};

export interface FileMenuProps {
  /** Relative to the workspace root, or to the repository when not `inWorkspace`. */
  readonly path: string;
  /** `false` for a Changes file outside the workspace, which is only copied or added to the chat. */
  readonly inWorkspace?: boolean;
  readonly isDirectory?: boolean;
  /** `false` for a file no longer on disk, which is only copied or added to the chat. */
  readonly exists?: boolean;
  /** The thread or draft "Add to chat" writes into; `null` leaves it out. */
  readonly chatId: string | null;
  /** The Files tab's own open, for its rows; elsewhere the thread view answers. */
  readonly onOpenInFiles?: () => void;
}

/** "Add to chat", its own component so the draft is read only while the menu is open. */
function AddToChatItem({
  parts,
  chatId,
  path,
}: {
  parts: MenuParts;
  chatId: string;
  path: string;
}) {
  const draft = useComposerDraft(chatId);
  const dispatch = useKeybindingDispatch();
  return (
    <parts.Item
      onClick={() => {
        draft.setText((current) => appendToDraft(current, `\`${path}\``));
        toast.success("Added the file to your message");
        dispatch("composer.focus");
      }}
    >
      <Chat variant="bold" />
      Add to chat
    </parts.Item>
  );
}

function FileMenuItems({
  parts,
  path,
  isDirectory = false,
  exists = true,
  inWorkspace = true,
  chatId,
  onOpenInFiles,
}: FileMenuProps & { parts: MenuParts }) {
  const scope = useFileMenuScope();
  const detected = useDetectedEditors();
  // Without a scope there is no workspace to open in, so no app is offered.
  const editors = scope === null ? [] : detected;
  const { favourite } = useFavouriteEditor(editors);
  const openWithToast = useOpenInWithToast();
  const requestReveal = useRequestFileReveal();

  const threadId = scope?.threadId ?? null;
  const groups = fileMenuEntries({
    path,
    isDirectory,
    exists,
    inWorkspace,
    root: scope?.root ?? null,
    editors,
    favourite,
    filesTab: onOpenInFiles !== undefined ? "open" : threadId !== null ? "reveal" : null,
    canAddToChat: chatId !== null,
  });

  const open = (app: DetectedEditor, reveal: boolean) => {
    if (scope === null) return;
    void openWithToast(app, {
      projectId: scope.projectId,
      threadId: scope.threadId ?? undefined,
      path,
      ...(reveal ? { reveal: true } : {}),
    });
  };

  const item = (entry: FileMenuEntry, key: string) => {
    switch (entry.kind) {
      case "files-tab":
        return (
          <parts.Item
            key={key}
            onClick={() => {
              if (onOpenInFiles !== undefined) onOpenInFiles();
              else if (threadId !== null) requestReveal(threadId, { path });
            }}
          >
            <FileIcon variant="bold" />
            {entry.label}
          </parts.Item>
        );
      case "open":
        return (
          <parts.Item key={key} onClick={() => open(entry.editor, false)}>
            <Code variant="bold" />
            Open in {entry.editor.label}
          </parts.Item>
        );
      case "open-with":
        return (
          <parts.Sub key={key}>
            <parts.SubTrigger>
              <ExternalLink variant="bold" />
              Open with
            </parts.SubTrigger>
            <parts.SubContent className="w-44">
              {entry.editors.map((editor) => (
                <parts.Item key={editor.id} onClick={() => open(editor, false)}>
                  <Code variant="bold" />
                  {editor.label}
                </parts.Item>
              ))}
            </parts.SubContent>
          </parts.Sub>
        );
      case "reveal":
        return (
          <parts.Item key={key} onClick={() => open(entry.app, true)}>
            <FolderOpen variant="bold" />
            Reveal in {entry.app.label}
          </parts.Item>
        );
      case "copy": {
        const Icon = entry.label === "Copy path" ? Clipboard : Copy;
        return (
          <parts.Item key={key} onClick={() => void copyPath(entry.text)}>
            <Icon variant="bold" />
            {entry.label}
          </parts.Item>
        );
      }
      case "add-to-chat":
        return chatId === null ? null : (
          <AddToChatItem key={key} parts={parts} chatId={chatId} path={path} />
        );
    }
  };

  return groups.map((group, index) => (
    <React.Fragment key={index}>
      {index > 0 ? <parts.Separator /> : null}
      {group.map((entry, at) => item(entry, `${entry.kind}-${at}`))}
    </React.Fragment>
  ));
}

/** The entries as `DropdownMenu` items, for a "…" menu's content. */
export function FileDropdownItems(props: FileMenuProps) {
  return <FileMenuItems parts={DROPDOWN} {...props} />;
}

/** The entries as `ContextMenu` items, for a right-click menu's content. */
export function FileContextItems(props: FileMenuProps) {
  return <FileMenuItems parts={CONTEXT} {...props} />;
}

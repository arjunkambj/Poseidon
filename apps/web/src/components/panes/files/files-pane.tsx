/**
 * The dock's Files tab — the workspace behind the thread, over `files.search`
 * and `files.read`.
 *
 * Search is the navigation. `files.search` matches on the whole path, so a
 * directory row drills in by searching its own prefix: one RPC does both
 * "find me the router" and "show me what is under apps/web/src". The listing
 * the server searches is ignore-aware for a git repository and an ignore-aware
 * filesystem walk for a plain folder, so a project that is not a repository
 * behaves the same here — there is no git state on this tab at all.
 *
 * The thread picks the directory: its worktree, when it has one, and the
 * project's folder otherwise. On the New task page there is no thread yet
 * (`threadId` null), and the tab searches the project's folder.
 *
 * Opening a row swaps the list for `FilePreview`; the breadcrumb goes back.
 * A right-click on a row opens the file menu (`@/components/open-in`): open
 * it here or in an editor, reveal it, copy its path, add it to the chat.
 * Everything else — loading, an empty query, no matches, a server error, an
 * offline socket — has its own honest block rather than an empty list.
 *
 * Where the tab was left — the search, the open file and its page, the
 * scroll of the list and of the file — is kept per workspace in
 * `./files-view` (`workspaceKey`: the thread, or the project's own folder), so
 * switching to another dock tab and back finds it as it was. The dock mounts
 * this per workspace (`key`), so one's scroll is never saved as another's.
 *
 * `focusSearch` puts the cursor in the search field — the dock's Files key
 * sets it when it opens this tab — and `onSearchFocused` reports that it was
 * used, so the request is spent once rather than on every later mount.
 *
 * A file chip in the timeline opens a file at a line by writing it into the
 * same view (`useRevealFile`, from the thread view): the preview shows the
 * page with that line, marks it, and scrolls it into view once — asking for
 * another line of the file already open moves to it.
 */

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { FileQuery } from "@poseidon/client-runtime/fileAtoms";
import type { ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { FileSearchResult } from "@poseidon/contracts/rpc";
import { Button } from "@poseidon/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@poseidon/ui/components/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { Input } from "@poseidon/ui/components/input";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { FileContextItems } from "@/components/open-in/file-menu-items";
import { FileMenuScopeProvider } from "@/components/open-in/file-menu-scope";
import { cn } from "@/lib/utils";
import { workspaceKey } from "@/lib/workspace-key";

import { FilePreview } from "./file-preview";
import { useFileAtoms } from "./file-atoms";
import { openedPreview, useFilesView, useKeptScroll } from "./files-view";
import { PaneMessage } from "./pane-message";
import { splitPath } from "./preview";
import {
  AlertTriangle,
  ChevronLeft,
  File as FileIcon,
  Folder,
  Repeat,
  Search as SearchIcon,
  Spinner,
  WifiOff,
} from "@honeyicons/react";

/** The server's own ceiling (`MAX_SEARCH_LIMIT`), asked for explicitly so the
 * pane can tell "these are all the matches" from "this is the first page". */
const SEARCH_LIMIT = 200;

type Query = FileQuery<ReadonlyArray<FileSearchResult>> | "broken" | null;

function ResultRow({
  result,
  chatId,
  onOpen,
}: {
  readonly result: FileSearchResult;
  /** The thread "Add to chat" writes into; `null` on the New task page. */
  readonly chatId: string | null;
  readonly onOpen: (result: FileSearchResult) => void;
}) {
  const { directory, name } = splitPath(result.path);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            onClick={() => onOpen(result)}
            title={result.path}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left outline-none",
              "hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
            )}
          />
        }
      >
        {result.isDirectory ? (
          <Folder variant="bold" className="size-3.5 shrink-0 text-foreground/85" />
        ) : (
          <FileIcon variant="bold" className="size-3.5 shrink-0 text-foreground/85" />
        )}
        <span className="min-w-0 truncate type-body text-foreground">{name}</span>
        {directory === "" ? null : (
          <span className="ml-auto min-w-0 shrink truncate type-micro text-muted-foreground">
            {directory}
          </span>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <FileContextItems
          path={result.path}
          isDirectory={result.isDirectory}
          chatId={chatId}
          onOpenInFiles={() => onOpen(result)}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function SearchBody({
  query,
  results,
  stale,
  onOpen,
  onRetry,
  connected,
  scroll,
  chatId,
}: {
  readonly query: string;
  readonly results: Query;
  /** These matches are the previous query's, held while the next one loads. */
  readonly stale: boolean;
  readonly onOpen: (result: FileSearchResult) => void;
  readonly onRetry: () => void;
  readonly connected: boolean;
  /** Keeps the list's scroll across a trip to another tab (`useKeptScroll`). */
  readonly scroll: ReturnType<typeof useKeptScroll>;
  readonly chatId: string | null;
}) {
  if (!connected) {
    return <PaneMessage icon={WifiOff} text="Not connected to the server." />;
  }
  if (query === "") {
    return (
      <PaneMessage
        icon={SearchIcon}
        text="Search this project's files."
        detail="Anything .gitignore excludes is left out."
      />
    );
  }
  const retry = (
    <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
      <Repeat variant="bold" />
      Try again
    </Button>
  );
  if (results === null) {
    return <PaneMessage icon={Spinner} text="Searching…" />;
  }
  if (results === "broken") {
    return (
      <PaneMessage icon={AlertTriangle} text="Could not search this project." action={retry} />
    );
  }
  if (results._tag === "error") {
    return <PaneMessage icon={AlertTriangle} text={results.message} action={retry} />;
  }
  if (results.value.length === 0) {
    return <PaneMessage icon={SearchIcon} text="No files match this search." />;
  }
  return (
    <div
      ref={scroll.ref}
      onScroll={scroll.onScroll}
      className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", stale && "opacity-60")}
    >
      <div className="flex flex-col gap-px px-1.5 py-1">
        {results.value.map((result) => (
          <ResultRow key={result.path} result={result} chatId={chatId} onOpen={onOpen} />
        ))}
      </div>
      {results.value.length >= SEARCH_LIMIT ? (
        <p className="shrink-0 px-3 pb-2 type-micro text-muted-foreground">
          First {SEARCH_LIMIT} matches — narrow the search to see the rest.
        </p>
      ) : null}
    </div>
  );
}

export function FilesPane({
  projectId,
  threadId,
  connected,
  focusSearch = false,
  onSearchFocused,
}: {
  readonly projectId: ProjectId;
  /** The thread whose workspace this searches; `null` searches the project's folder. */
  readonly threadId: ThreadId | null;
  readonly connected: boolean;
  readonly focusSearch?: boolean;
  readonly onSearchFocused?: () => void;
}) {
  const atoms = useFileAtoms();
  const searchRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (focusSearch) {
      searchRef.current?.focus();
      onSearchFocused?.();
    }
  }, [focusSearch, onSearchFocused]);
  const viewKey = workspaceKey({ projectId, threadId });
  const [view, updateView] = useFilesView(viewKey);
  const { query, preview } = view;
  const setQuery = (next: string) =>
    updateView((current) => ({ ...current, query: next, listScroll: 0, preview: null }));
  const setOpenPath = (path: string | null) =>
    updateView((current) => ({ ...current, preview: path === null ? null : openedPreview(path) }));

  const onRevealed = React.useCallback(
    () =>
      updateView((current) =>
        current.preview?.reveal === true
          ? { ...current, preview: { ...current.preview, reveal: false } }
          : current,
      ),
    [updateView],
  );

  // The scroll offsets live in refs while the pane is up and are saved as it
  // goes, rather than written to the atom on every scroll event.
  const listScroll = React.useRef(view.listScroll);
  const previewScroll = React.useRef(preview?.scroll ?? 0);
  const keptList = useKeptScroll(listScroll);
  const keptPreview = useKeptScroll(previewScroll);
  React.useEffect(
    () => () =>
      updateView((current) => ({
        ...current,
        listScroll: listScroll.current,
        preview:
          current.preview === null ? null : { ...current.preview, scroll: previewScroll.current },
      })),
    [updateView],
  );

  // The family key is the trimmed query, so leading and trailing spaces do not
  // each open their own atom — and it is deferred, the way the composer's
  // @-search already does it, so a burst of keystrokes opens one atom rather
  // than one per character. Without that every keystroke keys a fresh family
  // member, which starts in `Initial`: the list would blank to "Searching…"
  // and redraw on each letter instead of narrowing.
  const trimmed = React.useDeferredValue(query.trim());
  const searchAtom = atoms.fileSearchAtom({
    projectId,
    threadId: threadId ?? undefined,
    query: trimmed,
    limit: SEARCH_LIMIT,
  });
  const result = useAtomValue(searchAtom);
  const refresh = useAtomRefresh(searchAtom);

  const results: Query = AsyncResult.isSuccess(result)
    ? result.value
    : AsyncResult.isFailure(result)
      ? "broken"
      : null;

  // Hold the previous query's matches while the next atom is still `Initial`,
  // so the list narrows instead of blanking to "Searching…" between letters.
  // The workspace is part of what is held: another thread's directory —
  // another project, or another worktree — is not a stale view of this one.
  const held = React.useRef<{ viewKey: string; results: Query }>({ viewKey, results: null });
  if (results !== null || held.current.viewKey !== viewKey) {
    held.current = { viewKey, results };
  }
  const shown = results ?? held.current.results;

  // A directory is a navigation, not a file: search its own prefix so the list
  // becomes its contents.
  const open = (hit: FileSearchResult) => {
    if (hit.isDirectory) {
      listScroll.current = 0;
      setQuery(`${hit.path}/`);
      return;
    }
    previewScroll.current = 0;
    setOpenPath(hit.path);
  };

  return (
    <div data-context="files" className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-2 py-1.5">
        <Input
          ref={searchRef}
          value={query}
          placeholder="Search files…"
          aria-label="Search files"
          onChange={(event) => {
            listScroll.current = 0;
            setQuery(event.target.value);
          }}
        />
      </div>
      {preview === null ? (
        <FileMenuScopeProvider projectId={projectId} threadId={threadId}>
          <SearchBody
            query={trimmed}
            results={shown}
            stale={results === null && shown !== null}
            onOpen={open}
            onRetry={refresh}
            connected={connected}
            scroll={keptList}
            chatId={threadId}
          />
        </FileMenuScopeProvider>
      ) : (
        <>
          <div className="flex h-8 shrink-0 items-center gap-1 px-1.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Back to results"
                    onClick={() => setOpenPath(null)}
                  />
                }
              >
                <ChevronLeft variant="bold" />
              </TooltipTrigger>
              <TooltipContent>Back to results</TooltipContent>
            </Tooltip>
            <span
              className="min-w-0 truncate font-mono text-xs text-foreground"
              title={preview.path}
            >
              {preview.path}
            </span>
          </div>
          <FilePreview
            key={preview.path}
            projectId={projectId}
            threadId={threadId}
            path={preview.path}
            connected={connected}
            page={preview}
            onPageChange={(offset, visited) =>
              updateView((current) =>
                current.preview?.path === preview.path
                  ? { ...current, preview: { ...current.preview, offset, visited } }
                  : current,
              )
            }
            onRevealed={onRevealed}
            scroll={keptPreview}
          />
        </>
      )}
    </div>
  );
}

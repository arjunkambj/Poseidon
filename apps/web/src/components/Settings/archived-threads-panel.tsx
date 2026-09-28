/**
 * The Archived threads page: every archived thread, grouped by project, with
 * Unarchive and Delete.
 *
 * Archiving takes a thread out of the sidebar tree, so this is where archived
 * threads live — and the way back. Unarchive puts the thread back in the
 * sidebar; Delete is durable and asks first. Both go through the same
 * dispatch as the sidebar row menu (`thread-actions`), so a refusal reads the
 * same in either place.
 *
 * The data is the sidebar's own thread list subscription, which carries
 * archived threads with status `archived`; grouping is `./archived-groups`.
 */

import { Link } from "@tanstack/react-router";
import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";
import type { ThreadSummary } from "@poseidon/contracts/orchestration";

import { DeleteThreadDialog } from "@/components/sidebar/delete-thread-dialog";
import { threadCommandBase, useThreadCommand } from "@/components/sidebar/thread-actions";
import { useDeleteThread } from "@/components/sidebar/use-delete-thread";
import { useConnectionState, useLoadedThreadList, useProjects } from "@/state/hooks";
import { Archive, ArchiveUp, Spinner, Trash } from "@honeyicons/react";

import { archivedGroups } from "./archived-groups";
import { SettingsPageHeader, SettingsSection } from "./settings-section";

const UPDATED_AT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function ArchivedRow({
  thread,
  disabled,
  onUnarchive,
  onDelete,
}: {
  readonly thread: ThreadSummary;
  readonly disabled: boolean;
  readonly onUnarchive: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <Link
          to="/t/$threadId"
          params={{ threadId: thread.threadId }}
          className="truncate text-sm font-medium hover:underline"
        >
          {thread.title}
        </Link>
        {thread.preview === undefined || thread.preview === "" ? null : (
          <span className="truncate text-xs text-muted-foreground">{thread.preview}</span>
        )}
      </div>
      {/* The last update, not the archive time: a rename or a late turn
          settlement after archiving moves it, and no archive time is stored. */}
      <time
        dateTime={thread.updatedAt}
        title="Last updated"
        className="shrink-0 text-xs text-muted-foreground tabular-nums"
      >
        Updated {UPDATED_AT.format(new Date(thread.updatedAt))}
      </time>
      <Button variant="outline" size="sm" disabled={disabled} onClick={onUnarchive}>
        <ArchiveUp variant="bold" />
        Unarchive
      </Button>
      <Button
        variant="destructive"
        size="sm"
        disabled={disabled}
        aria-label={`Delete ${thread.title}`}
        onClick={onDelete}
      >
        <Trash variant="bold" />
        Delete
      </Button>
    </li>
  );
}

export function ArchivedThreadsPanel() {
  const threads = useLoadedThreadList();
  const projects = useProjects();
  const connection = useConnectionState();
  const send = useThreadCommand();
  const remove = useDeleteThread();
  const [deleting, setDeleting] = React.useState<ThreadSummary | null>(null);

  const groups = React.useMemo(
    () => (threads === null ? null : archivedGroups(threads, projects)),
    [threads, projects],
  );
  const disabled = connection.status !== "connected";

  const unarchive = (thread: ThreadSummary) =>
    void send(
      { type: "thread.unarchive", ...threadCommandBase(thread.threadId) },
      "Thread was not unarchived",
      "Unarchived",
    );

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="Archived threads"
        description="Archived threads are kept, not deleted. Unarchive one to put it back in the sidebar."
      />

      {groups === null ? (
        // The list has not arrived yet. Saying "No archived threads" here
        // would claim an answer the server has not given.
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {disabled ? <Archive variant="bold" /> : <Spinner variant="bold" />}
            </EmptyMedia>
            <EmptyTitle>{disabled ? "Not connected" : "Loading archived threads…"}</EmptyTitle>
            {disabled ? (
              <EmptyDescription>Connect to a server to see archived threads.</EmptyDescription>
            ) : null}
          </EmptyHeader>
        </Empty>
      ) : groups.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Archive variant="bold" />
            </EmptyMedia>
            <EmptyTitle>No archived threads</EmptyTitle>
            <EmptyDescription>
              Archive a thread from its menu in the sidebar and it shows up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        groups.map((group) => (
          <SettingsSection key={group.projectId ?? "other"} title={group.name}>
            <ul className="flex flex-col divide-y divide-border">
              {group.threads.map((thread) => (
                <ArchivedRow
                  key={thread.threadId}
                  thread={thread}
                  disabled={disabled}
                  onUnarchive={() => unarchive(thread)}
                  onDelete={() => setDeleting(thread)}
                />
              ))}
            </ul>
          </SettingsSection>
        ))
      )}

      {/* One dialog for the page, not one per row: it names whichever thread
          is pending deletion. Deleting has no undo, so it asks first. */}
      <DeleteThreadDialog
        thread={deleting}
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleting(null);
          }
        }}
        onConfirm={(thread, removeWorktree) => void remove(thread, removeWorktree)}
      />
    </div>
  );
}

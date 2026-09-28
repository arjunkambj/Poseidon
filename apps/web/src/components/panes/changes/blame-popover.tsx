/**
 * Blame on demand, in a popover: nothing is read until the user asks.
 *
 * - A file's "Show blame" lists the commits behind its working copy
 *   (`blameCommits`), anchored to the file's sticky row: short sha, summary,
 *   author, how long ago and how many lines. A file git does not track has no
 *   history, and says so.
 * - A line number clicked in the diff (Uncommitted and Branch only, where the
 *   new side is the working file) shows that one line's commit, anchored to
 *   the number that was clicked.
 *
 * The `git.blame` atom mounts with the popover's content, only while it is
 * open, and the path is the one `git.diff` answered with — relative to the
 * repository's top level, which is where the server blames from.
 */

import { useAtomValue } from "@effect/atom-react";
import type { GitBlame } from "@poseidon/contracts/git-review";
import { Popover, PopoverContent } from "@poseidon/ui/components/popover";
import type * as React from "react";

import { formatFullDate } from "@/lib/format";
import { useNow } from "@/lib/use-now";

import { blameAge, blameAt, blameCommits } from "./blame";
import { queryValue } from "./changes-list";
import type { ReviewWhere } from "./discard";
import { useGitReview } from "./git-atoms";

import { AlertTriangle, GitCommit, Spinner } from "@honeyicons/react";

/** What the popover shows: the whole file, or one line of it. */
export type BlameRequest =
  | { readonly kind: "file" }
  | { readonly kind: "line"; readonly line: number; readonly anchor: Element };

/** A one-line status inside the popover: loading, a refusal, or nothing to show. */
function BlameNote({ icon: Glyph, text }: { icon: typeof Spinner; text: string }) {
  return (
    <p className="flex items-center gap-2 type-body text-muted-foreground">
      <Glyph variant="bold" className="size-3.5 shrink-0" />
      <span className="min-w-0">{text}</span>
    </p>
  );
}

/** The blame of `path`, or of one line, read while mounted; `children` renders the answer. */
function BlameQuery({
  where,
  path,
  line,
  children,
}: {
  where: ReviewWhere;
  path: string;
  line?: number;
  children: (blame: GitBlame) => React.ReactNode;
}) {
  // The review atoms read through the pane's git atoms, so a refresh rereads the blame too.
  const { blameAtom } = useGitReview();
  const result = queryValue<GitBlame>(
    useAtomValue(
      blameAtom({
        projectId: where.projectId,
        ...(where.threadId === undefined ? {} : { threadId: where.threadId }),
        path,
        ...(line === undefined ? {} : { startLine: line, endLine: line }),
      }),
    ),
  );
  if (result === null) {
    return <BlameNote icon={Spinner} text="Loading blame…" />;
  }
  if (result._tag === "broken") {
    return <BlameNote icon={AlertTriangle} text="Could not read the blame." />;
  }
  if (result._tag === "error") {
    return <BlameNote icon={AlertTriangle} text={result.message} />;
  }
  if (result.value.untracked) {
    return <BlameNote icon={GitCommit} text="Not committed yet: git does not track this file." />;
  }
  return children(result.value);
}

/** Short sha in mono, then the summary; a working-tree line reads "Not committed yet". */
function CommitLine({
  shortSha,
  summary,
  uncommitted,
}: {
  shortSha: string;
  summary: string;
  uncommitted: boolean;
}) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      {uncommitted ? null : (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{shortSha}</span>
      )}
      <span className="min-w-0 truncate text-foreground">
        {uncommitted ? "Not committed yet" : summary}
      </span>
    </span>
  );
}

function FileBlame({ where, path }: { where: ReviewWhere; path: string }) {
  const now = useNow(60_000);
  return (
    <BlameQuery where={where} path={path}>
      {(blame) => {
        const commits = blameCommits(blame.entries);
        if (commits.length === 0) {
          return <BlameNote icon={GitCommit} text="No lines to blame." />;
        }
        return (
          <ul className="-mx-1 flex max-h-72 flex-col overflow-y-auto">
            {commits.map((commit) => (
              <li key={commit.sha} className="flex flex-col gap-0.5 rounded-md px-1.5 py-1">
                <CommitLine {...commit} />
                <span className="type-micro text-muted-foreground">
                  {commit.uncommitted ? "Working copy" : commit.author}
                  {commit.uncommitted ? "" : ` · ${blameAge(now, commit.time)}`} ·{" "}
                  {commit.lines === 1 ? "1 line" : `${commit.lines} lines`}
                </span>
              </li>
            ))}
          </ul>
        );
      }}
    </BlameQuery>
  );
}

function LineBlame({ where, path, line }: { where: ReviewWhere; path: string; line: number }) {
  const now = useNow(60_000);
  return (
    <BlameQuery where={where} path={path} line={line}>
      {(blame) => {
        const entry = blameAt(blame.entries, line);
        if (entry === undefined) {
          return <BlameNote icon={GitCommit} text={`No blame for line ${line}.`} />;
        }
        if (entry.uncommitted) {
          return <BlameNote icon={GitCommit} text={`Line ${line} is not committed yet.`} />;
        }
        const at = Date.parse(entry.time);
        return (
          <div className="flex flex-col gap-1">
            <CommitLine
              shortSha={entry.sha.slice(0, 7)}
              summary={entry.summary}
              uncommitted={false}
            />
            <span className="type-micro text-muted-foreground">
              {entry.author} · {blameAge(now, entry.time)}
              {Number.isNaN(at) ? "" : ` · ${formatFullDate(at)}`}
            </span>
          </div>
        );
      }}
    </BlameQuery>
  );
}

/**
 * The blame popover of one file row. `fileAnchor` is the file's sticky row;
 * a line request carries the number that was clicked as its own anchor.
 */
export function BlamePopover({
  where,
  path,
  request,
  onClose,
  fileAnchor,
}: {
  /** Where to blame: the review scope's project and thread. */
  where: ReviewWhere;
  path: string;
  request: BlameRequest | null;
  onClose: () => void;
  fileAnchor: React.RefObject<Element | null>;
}) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    <Popover
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <PopoverContent
        anchor={request?.kind === "line" ? request.anchor : fileAnchor}
        align={request?.kind === "line" ? "start" : "end"}
        className="w-80"
      >
        {request === null ? null : (
          <>
            <p className="truncate type-micro text-muted-foreground" title={path}>
              {request.kind === "line" ? `Blame · ${name}:${request.line}` : `Blame · ${name}`}
            </p>
            {request.kind === "line" ? (
              <LineBlame where={where} path={path} line={request.line} />
            ) : (
              <FileBlame where={where} path={path} />
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

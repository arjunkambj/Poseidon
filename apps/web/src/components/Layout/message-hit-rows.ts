/**
 * The command palette's message hits as rows: what each one says beside its
 * title, and its snippet cut into marked and unmarked runs. Kept apart from
 * the group component so the wording and the marking are testable.
 */

import type { MessageSearchHit } from "@poseidon/contracts/search";

import { splitHighlights, type FindSegment } from "@/components/timeline/thread-find";

export interface MessageHitRow {
  /** The row's cmdk value — unique, and never the title-based one of the Threads group. */
  readonly value: string;
  readonly hit: MessageSearchHit;
  /** The project, as the Threads group names it; archived hits say so first. */
  readonly projectLabel: string;
  /** The snippet, with each occurrence of the query marked. */
  readonly segments: ReadonlyArray<FindSegment>;
}

/** A project's name for `projectId`, "Other threads" when it is not known. */
export const messageHitProject = (
  projects: ReadonlyArray<{ readonly projectId: string; readonly name: string }>,
  hit: Pick<MessageSearchHit, "projectId" | "archived">,
): string => {
  const name =
    projects.find((project) => project.projectId === hit.projectId)?.name ?? "Other threads";
  return hit.archived ? `Archived · ${name}` : name;
};

/** One row per hit, in the server's order. */
export const messageHitRows = (
  hits: ReadonlyArray<MessageSearchHit>,
  projects: ReadonlyArray<{ readonly projectId: string; readonly name: string }>,
  query: string,
): ReadonlyArray<MessageHitRow> =>
  hits.map((hit) => ({
    value: `message ${hit.threadId}`,
    hit,
    projectLabel: messageHitProject(projects, hit),
    segments: splitHighlights(hit.snippet, query),
  }));

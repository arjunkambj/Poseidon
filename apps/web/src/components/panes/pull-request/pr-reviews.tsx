/**
 * The Pull request tab's reviews: the review decision and each reviewer's
 * latest verdict, then the review threads by file — `path:line`, outdated
 * or not, every comment in it — with the resolved ones folded away under a
 * count, and last the conversation's own comments.
 */

import { Badge } from "@poseidon/ui/components/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@poseidon/ui/components/collapsible";
import type {
  PullRequestDetail,
  PullRequestReview,
  PullRequestReviewThread,
} from "@poseidon/contracts/pullRequest";

import * as React from "react";

import { cn } from "@/lib/utils";

import { ChevronRight } from "@honeyicons/react";

import { type CommentActions, OpenInChangesAction, PrComment } from "./pr-comment";
import {
  conversationQuote,
  groupThreadsByFile,
  latestReviews,
  reviewCommentQuote,
  threadLineLabel,
  type ThreadGroup,
  visibleBody,
} from "./pr-format";

const DECISION: Record<
  NonNullable<PullRequestDetail["reviewDecision"]>,
  { readonly label: string; readonly variant: "secondary" | "destructive" | "outline" }
> = {
  approved: { label: "Approved", variant: "secondary" },
  "changes-requested": { label: "Changes requested", variant: "destructive" },
  "review-required": { label: "Review required", variant: "outline" },
};

const VERDICT: Record<PullRequestReview["state"], string> = {
  approved: "approved",
  "changes-requested": "requested changes",
  commented: "commented",
  dismissed: "dismissed",
  pending: "pending",
};

function SectionTitle({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <h3 className="flex h-7 items-center gap-2 px-3 text-xs font-medium text-muted-foreground">
      {title}
      {children}
    </h3>
  );
}

function ReviewThread({
  thread,
  nowMs,
  actions,
}: {
  readonly thread: PullRequestReviewThread;
  readonly nowMs: number;
  readonly actions: CommentActions;
}) {
  return (
    <li className="flex flex-col gap-1 border-l border-border pl-2">
      <div className="flex h-7 items-center gap-2 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{threadLineLabel(thread)}</span>
        {thread.isOutdated ? <Badge variant="outline">Outdated</Badge> : null}
        {thread.isResolved ? <Badge variant="outline">Resolved</Badge> : null}
        <span className="ml-auto flex shrink-0 items-center">
          <OpenInChangesAction onClick={() => actions.onOpenInChanges(thread.path)} />
        </span>
      </div>
      {thread.comments.map((comment) => (
        <PrComment
          key={comment.url}
          author={comment.author}
          at={comment.createdAt}
          body={comment.body}
          nowMs={nowMs}
          onAddToChat={() => actions.onAddToChat(reviewCommentQuote(thread, comment))}
        />
      ))}
    </li>
  );
}

function ThreadGroups({
  groups,
  nowMs,
  actions,
}: {
  readonly groups: ReadonlyArray<ThreadGroup>;
  readonly nowMs: number;
  readonly actions: CommentActions;
}) {
  return (
    <div className="flex flex-col gap-2 px-3">
      {groups.map((group) => (
        <div key={group.path} className="flex flex-col gap-1">
          <div title={group.path} className="truncate text-xs font-medium text-foreground">
            {group.path}
          </div>
          <ul className="flex flex-col gap-2">
            {group.threads.map((thread) => (
              <ReviewThread key={thread.id} thread={thread} nowMs={nowMs} actions={actions} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function PrReviews({
  pullRequest,
  nowMs,
  actions,
}: {
  readonly pullRequest: PullRequestDetail;
  readonly nowMs: number;
  readonly actions: CommentActions;
}) {
  const decision =
    pullRequest.reviewDecision === null ? null : DECISION[pullRequest.reviewDecision];
  const reviews = latestReviews(pullRequest.reviews);
  const open = pullRequest.reviewThreads.filter((thread) => !thread.isResolved);
  const resolved = pullRequest.reviewThreads.filter((thread) => thread.isResolved);
  const [showResolved, setShowResolved] = React.useState(false);
  const quoteConversation = (comment: { readonly author: string; readonly body: string }) => () =>
    actions.onAddToChat(conversationQuote(pullRequest.number, comment));

  return (
    <>
      <section aria-label="Reviews" className="flex flex-col">
        <SectionTitle title="Reviews">
          {decision === null ? null : <Badge variant={decision.variant}>{decision.label}</Badge>}
        </SectionTitle>
        {reviews.length === 0 ? (
          <p className="px-3 text-xs text-muted-foreground">No reviews yet.</p>
        ) : (
          <div className="flex flex-col gap-1 px-3">
            {reviews.map((review) => (
              <PrComment
                key={review.author}
                author={review.author}
                at={review.submittedAt}
                body={review.body}
                nowMs={nowMs}
                badge={
                  <span className="shrink-0 text-muted-foreground">{VERDICT[review.state]}</span>
                }
                onAddToChat={visibleBody(review.body) === "" ? null : quoteConversation(review)}
              />
            ))}
          </div>
        )}
      </section>
      <section aria-label="Review threads" className="flex flex-col">
        <SectionTitle title="Review threads">
          <span className="font-normal">
            {open.length} open{resolved.length === 0 ? "" : `, ${resolved.length} resolved`}
          </span>
        </SectionTitle>
        {open.length === 0 ? null : (
          <ThreadGroups groups={groupThreadsByFile(open)} nowMs={nowMs} actions={actions} />
        )}
        {resolved.length === 0 ? null : (
          <Collapsible open={showResolved} onOpenChange={setShowResolved}>
            <div className="px-3">
              <CollapsibleTrigger variant="summary">
                <ChevronRight
                  variant="bold"
                  className={cn("size-3 transition-transform", showResolved && "rotate-90")}
                />
                {resolved.length} resolved
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <ThreadGroups groups={groupThreadsByFile(resolved)} nowMs={nowMs} actions={actions} />
            </CollapsibleContent>
          </Collapsible>
        )}
      </section>
      <section aria-label="Conversation" className="flex flex-col">
        <SectionTitle title="Conversation">
          <span className="font-normal">{pullRequest.comments.length}</span>
        </SectionTitle>
        {pullRequest.comments.length === 0 ? null : (
          <div className="flex flex-col gap-1 px-3">
            {pullRequest.comments.map((comment) => (
              <PrComment
                key={comment.url}
                author={comment.author}
                at={comment.createdAt}
                body={comment.body}
                nowMs={nowMs}
                onAddToChat={quoteConversation(comment)}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

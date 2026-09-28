/**
 * The proposed-plan card. `accept` and `accept-auto` dispatch
 * `thread.plan.respond` directly; `revise` opens the feedback field and sends
 * it with the response. The card closes when `thread.plan.responded` clears
 * `doc.pendingPlan` — nothing here closes it optimistically. Implement in new
 * thread, Copy and Save as .md sit at the end of the row (`./plan-actions`).
 *
 * Keys, by default: `1` accept, `2` accept and run, `3` open the feedback
 * field. They are the `plan.*` rows of the keybinding table, live while
 * `planPending && !inputFocus && !dialogOpen`. `Escape` is not among them: a
 * plan is not a prompt that blocks on an answer, so the card has nothing to
 * deny, and Escape keeps its ordinary meaning. The labels read the live table.
 */

import { useAtomSet } from "@effect/atom-react";
import { Button } from "@poseidon/ui/components/button";
import { Kbd } from "@poseidon/ui/components/kbd";
import { Textarea } from "@poseidon/ui/components/textarea";
import type { ThreadId, TurnId } from "@poseidon/contracts/ids";
import { makeCommandId } from "@poseidon/contracts/ids";
import type { PlanResponseAction } from "@poseidon/contracts/orchestration";
import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CardShell } from "@/components/approvals/card-shell";
import { PlanActions } from "@/components/approvals/plan-actions";
import { useClientRuntime } from "@/lib/client-runtime";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { CommandKbd, useKeybindingCommand } from "@/lib/shortcuts";
import { ListChecks } from "@honeyicons/react";

/** The elements a plan actually uses, styled against theme tokens. */
const markdownComponents = {
  h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 className="mt-2 mb-1 text-base font-semibold" {...props} />
  ),
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 className="mt-2 mb-1 text-sm font-semibold" {...props} />
  ),
  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className="mt-2 mb-1 text-sm font-medium" {...props} />
  ),
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="my-1 leading-prose" {...props} />
  ),
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="my-1 list-disc pl-5" {...props} />
  ),
  ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
    <ol className="my-1 list-decimal pl-5" {...props} />
  ),
  li: (props: React.HTMLAttributes<HTMLLIElement>) => <li className="my-0.5" {...props} />,
  code: (props: React.HTMLAttributes<HTMLElement>) => (
    <code className="rounded-sm bg-muted px-1 font-mono text-xs" {...props} />
  ),
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
    <pre
      className="my-1 overflow-auto rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs"
      {...props}
    />
  ),
  /**
   * A plan is model output, so its links are whatever the agent read. They
   * leave through the window-open handler — never in this window — exactly as
   * the timeline's markdown does; `target` and `rel` are pinned after the
   * spread so the markdown cannot unset them.
   */
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a className="text-primary underline" {...props} target="_blank" rel="noreferrer" />
  ),
};

export function PlanCard({
  threadId,
  plan,
}: {
  readonly threadId: ThreadId;
  readonly plan: {
    readonly turnId: TurnId;
    readonly planMarkdown: string;
    readonly planPath?: string;
  };
}) {
  const { dispatchAtom } = useClientRuntime();
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });
  const [revising, setRevising] = React.useState(false);
  const [feedback, setFeedback] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<PlanResponseAction | null>(null);
  const feedbackRef = React.useRef<HTMLTextAreaElement>(null);

  const respond = React.useCallback(
    (action: PlanResponseAction, note?: string) => {
      setPending(action);
      setError(null);
      void dispatch({
        commandId: makeCommandId(),
        createdAt: new Date().toISOString(),
        type: "thread.plan.respond",
        threadId,
        turnId: plan.turnId,
        action,
        ...(note === undefined || note.length === 0 ? {} : { feedback: note }),
      }).then(
        (receipt) => {
          setPending(null);
          setError(receiptError(receipt, "the server rejected the response"));
        },
        () => {
          setPending(null);
          setError(DISPATCH_UNREACHABLE);
        },
      );
    },
    [dispatch, plan.turnId, threadId],
  );

  // Like the disabled buttons, a key does nothing while an answer is on its way.
  const byKey = (action: "accept" | "accept-auto") => () => {
    if (pending === null) {
      respond(action);
    }
  };
  useKeybindingCommand("plan.accept", byKey("accept"));
  useKeybindingCommand("plan.acceptAndRun", byKey("accept-auto"));
  useKeybindingCommand("plan.revise", () => {
    if (pending === null) {
      setRevising(true);
    }
  });

  React.useEffect(() => {
    if (revising) {
      feedbackRef.current?.focus();
    }
  }, [revising]);

  return (
    <CardShell
      icon={ListChecks}
      title="Proposed plan"
      hint={
        plan.planPath === undefined ? null : (
          <span className="max-w-48 truncate font-mono">{plan.planPath}</span>
        )
      }
      actions={
        <>
          <Button size="sm" disabled={pending !== null} onClick={() => respond("accept")}>
            Accept <CommandKbd command="plan.accept" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending !== null}
            onClick={() => respond("accept-auto")}
          >
            Accept and run <CommandKbd command="plan.acceptAndRun" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            tone="muted"
            disabled={pending !== null}
            onClick={() => setRevising((open) => !open)}
            aria-expanded={revising}
          >
            Revise <CommandKbd command="plan.revise" />
          </Button>
          <PlanActions
            threadId={threadId}
            markdown={plan.planMarkdown}
            handoffTurnId={plan.turnId}
          />
        </>
      }
    >
      <div className="max-h-56 max-w-none overflow-auto text-sm text-foreground">
        <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {plan.planMarkdown}
        </Markdown>
      </div>
      {revising ? (
        <div className="flex min-w-0 flex-col gap-2">
          <Textarea
            ref={feedbackRef}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="What should change?"
            aria-label="Plan feedback"
            rows={3}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                respond("revise", feedback.trim());
              }
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={pending !== null || feedback.trim().length === 0}
              onClick={() => respond("revise", feedback.trim())}
            >
              Send revision
            </Button>
            <span className="text-xs text-muted-foreground">
              <Kbd>⌘</Kbd>+<Kbd>Enter</Kbd> sends
            </span>
          </div>
        </div>
      ) : null}
      {error === null ? null : (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </CardShell>
  );
}

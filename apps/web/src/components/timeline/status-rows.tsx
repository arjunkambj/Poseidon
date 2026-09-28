/**
 * The quiet row kinds: `skill` is a chip, `error` is destructive,
 * `context_compaction` is a divider, and `unknown` is the honest fallback for
 * an item kind this build does not model.
 */

import type { ItemSnapshot } from "@poseidon/contracts/runtime";

import { FindText } from "@/components/timeline/thread-find-context";
import { AlertTriangle, InfoSquare, Minimize, Sparkles } from "@honeyicons/react";

export function SkillRow({ item }: { item: ItemSnapshot }) {
  return (
    <div className="flex min-h-6 items-center py-0.5">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-file-bg px-2.5 py-0.5 type-body text-file">
        <Sparkles variant="bold" className="size-3.5" />
        {item.text === undefined ? "skill" : <FindText text={item.text} />}
      </span>
    </div>
  );
}

export function ErrorRow({ item }: { item: ItemSnapshot }) {
  const message = item.error?.message ?? item.text;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg bg-removed-bg px-3 py-2 type-body text-removed"
    >
      <AlertTriangle variant="bold" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 whitespace-pre-wrap">
        {message === undefined ? "Something went wrong." : <FindText text={message} />}
      </span>
    </div>
  );
}

export function ContextCompactionRow({ item }: { item: ItemSnapshot }) {
  return (
    <div className="flex items-center gap-3 py-1" aria-label="Context compacted">
      <span className="h-px flex-1 bg-border" />
      <span className="inline-flex shrink-0 items-center gap-1.5 type-micro text-muted-foreground">
        <Minimize variant="bold" className="size-3.5" />
        {item.text ?? "Context compacted"}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function UnknownRow({ item }: { item: ItemSnapshot }) {
  return (
    <div className="flex min-h-6 items-center gap-2 py-0.5 type-body italic text-muted-foreground">
      <InfoSquare variant="bold" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{item.text ?? "Unrecognized timeline item"}</span>
    </div>
  );
}

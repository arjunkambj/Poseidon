/**
 * The `@` and `$` references: the thread instance's plugins and skills behind
 * the two menus, the pick that writes the reference's token into the draft
 * and records it, and the two ways a reference leaves again — its chip's
 * remove button, or its token being edited out of the text.
 *
 * Poseidon's own enabled plugins (`poseidonPluginsAtom`) lead the `@` list on
 * every harness, ahead of the instance's (`plugin-sources.ts`). An instance
 * whose harness has no plugins answers `[]` (see `pluginsAtom`), so `@` then
 * lists Poseidon's plugins and the skills.
 * While a list is still being asked, or when it fails, the empty row says that
 * instead (`menuSource`, `referenceMenuEmptyLabel`).
 * How a reference reaches the harness is the connector's business: the turn
 * carries only `{ kind, name }`.
 */

import { useAtomValue } from "@effect/atom-react";
import type { ConnectorInstanceId, ProjectId } from "@poseidon/contracts/ids";
import type { TurnReference } from "@poseidon/contracts/runtime";
import {
  removeComposerToken,
  replaceComposerTrigger,
  retainComposerReferences,
  type ComposerTrigger,
} from "@poseidon/client-runtime/composerTrigger";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { menuSource } from "@/components/composer/menu-source";
import { mergePluginSources, poseidonPluginSummaries } from "@/components/composer/plugin-sources";
import {
  REFERENCE_MENU_LABELS,
  referenceMenuEmptyLabel,
  referenceMenuItems,
  referenceToken,
  sameReference,
  type ReferenceMenuItem,
} from "@/components/composer/reference-menu";
import { useClientRuntime } from "@/lib/client-runtime";

export interface ReferenceMentions {
  /** The menu rows; empty unless the open trigger is `@` or `$`. */
  readonly items: ReadonlyArray<ReferenceMenuItem>;
  readonly emptyLabel: string;
  readonly label: string;
  readonly pick: (item: ReferenceMenuItem) => void;
  /** Pick the row at `index`, if there is one — Enter on the highlighted row. */
  readonly pickAt: (index: number) => void;
  readonly remove: (reference: TurnReference) => void;
  /** Drop references whose token the next text no longer holds. */
  readonly retain: (nextText: string) => void;
}

export function useReferenceMentions({
  instanceId,
  projectId,
  trigger,
  text,
  setText,
  setReferences,
  setTextAndCaret,
}: {
  readonly instanceId: ConnectorInstanceId | null;
  readonly projectId: ProjectId;
  readonly trigger: ComposerTrigger | null;
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly setReferences: React.Dispatch<React.SetStateAction<ReadonlyArray<TurnReference>>>;
  readonly setTextAndCaret: (text: string, caret: number) => void;
}): ReferenceMentions {
  const { pluginsAtom, poseidonPluginsAtom, skillsAtom } = useClientRuntime();
  const pluginsResult = useAtomValue(pluginsAtom(instanceId)(projectId));
  const poseidonResult = useAtomValue(poseidonPluginsAtom);
  const skillsResult = useAtomValue(skillsAtom(instanceId)(projectId));
  const pluginSource = React.useMemo(
    () =>
      mergePluginSources(
        menuSource(AsyncResult.map(poseidonResult, poseidonPluginSummaries)),
        menuSource(pluginsResult),
      ),
    [poseidonResult, pluginsResult],
  );
  const skillSource = menuSource(skillsResult);
  const plugins = pluginSource.entries;
  const skills = skillSource.entries;
  const kind = trigger?.kind === "mention" || trigger?.kind === "skill" ? trigger.kind : null;
  const query = trigger?.query ?? "";

  const items = React.useMemo<ReadonlyArray<ReferenceMenuItem>>(
    () => (kind === null ? [] : referenceMenuItems({ kind, query, plugins, skills })),
    [kind, query, plugins, skills],
  );
  const emptyLabel = referenceMenuEmptyLabel({
    kind: kind ?? "mention",
    query,
    plugins: pluginSource,
    skills: skillSource,
  });

  const pick = (item: ReferenceMenuItem) => {
    if (trigger === null) {
      return;
    }
    const next = replaceComposerTrigger(text, trigger, `${referenceToken(item.reference)} `);
    setReferences((current) =>
      current.some((entry) => sameReference(entry, item.reference))
        ? current
        : [...current, item.reference],
    );
    setTextAndCaret(next.text, next.cursor);
  };

  const pickAt = (index: number) => {
    const item = items[index];
    if (item !== undefined) {
      pick(item);
    }
  };

  const remove = (reference: TurnReference) => {
    setReferences((current) => current.filter((entry) => !sameReference(entry, reference)));
    setText(removeComposerToken(text, referenceToken(reference)));
  };

  const retain = (nextText: string) =>
    setReferences((current) => retainComposerReferences(current, nextText, referenceToken));

  return {
    items,
    emptyLabel,
    label: REFERENCE_MENU_LABELS[kind ?? "mention"],
    pick,
    pickAt,
    remove,
    retain,
  };
}

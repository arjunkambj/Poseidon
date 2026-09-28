/**
 * The composer. Textarea with `#` file mentions and `@` / `$` plugin and skill
 * references (chips, wired in `use-mention-menus`), a `/` command popover, file
 * attach, the queued-message strip, and the interaction-card slot — one card
 * at a time, above the input.
 *
 * Keys: Enter sends — while a turn runs it steers that turn when the harness
 * can take a message mid-turn and queues otherwise (`send-mode`) — unless an
 * open trigger menu has a row to pick, which `composer-keys` decides;
 * Shift+Enter newline. An Enter chord the keymap answers is its:
 * `composer.queue` (Mod+Enter) always queues, and it, focus, attach and clear
 * are `use-composer-commands`; other chords send, queued with Mod or Ctrl.
 * Escape closes an open menu and otherwise reaches the `thread.interrupt`
 * binding this component registers — the toolbar's Stop button is the same
 * call with a mouse. State reads `threadDetailAtom`; mutations go through
 * `dispatchAtom`; cards close on their resolved events — nothing here clears
 * them locally.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { cn } from "@poseidon/ui/lib/utils";
import { makeCommandId, type ProjectId, type ThreadId } from "@poseidon/contracts/ids";
import {
  detectComposerTrigger,
  replaceComposerTrigger,
} from "@poseidon/client-runtime/composerTrigger";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { HeaderControls } from "@/components/header-controls";
import { useProjects } from "@/state/hooks";
import { ComposerSurface, composerInputClassName } from "@/components/composer/composer-surface";
import { composerPlaceholder } from "@/components/composer/composer-placeholder";
import { ComposerChips } from "@/components/composer/composer-chips";
import { composerEnter, keymapChord, menuMove } from "@/components/composer/composer-keys";
import { ComposerToolbar } from "@/components/composer/composer-toolbar";
import { canSteer, sendMode } from "@/components/composer/send-mode";
import { canCompact, compactRefusal } from "@/components/composer/compact-now";
import { PendingCard } from "@/components/composer/pending-card";
import { QueueStrip } from "@/components/composer/queue-strip";
import { SlashMenu, slashMenuItems, type SlashMenuItem } from "@/components/composer/slash-menu";
import { useAttachments } from "@/components/composer/use-attachments";
import { useCompactNow } from "@/components/composer/use-compact-now";
import { useComposerCommands } from "@/components/composer/use-composer-commands";
import { useComposerTrigger } from "@/components/composer/use-composer-trigger";
import { useMentionMenus } from "@/components/composer/use-mention-menus";
import { usePromptRecall } from "@/components/composer/use-prompt-recall";
import { useInterrupt } from "@/components/composer/use-interrupt";
import { useSendDraft } from "@/components/composer/use-send-draft";
import { useClientRuntime } from "@/lib/client-runtime";
import { attachmentRefusal } from "@/lib/attachment-support";
import { instanceCapabilities, threadConnectorInstanceId } from "@/lib/connector-routing";
import { turnInFlight } from "@/lib/turn";
import { useKeybindingCommand, useKeybindingFlag, useKeymapAnswers } from "@/lib/shortcuts";
import { useChatWidth } from "@/lib/use-chat-width";
import { DISPATCH_UNREACHABLE, receiptError } from "@/lib/dispatch-outcome";
import { useComposerDraft } from "@/state/ui";
import { Folder } from "@honeyicons/react";

export function Composer({
  threadId,
  projectId,
  className,
}: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly className?: string;
}) {
  const project = useProjects().find((entry) => entry.projectId === projectId);
  const chatWidth = useChatWidth();
  const { threadDetailAtom, dispatchAtom, connectorsAtom, connectorModelsAtom, skillsAtom } =
    useClientRuntime();
  const docResult = useAtomValue(threadDetailAtom(threadId));
  const doc = AsyncResult.isSuccess(docResult) ? docResult.value : null;
  const dispatch = useAtomSet(dispatchAtom, { mode: "promise" });

  // Not `doc.session` alone: unbound, the chosen or default instance answers.
  const connectorsResult = useAtomValue(connectorsAtom);
  const connectors = AsyncResult.isSuccess(connectorsResult) ? connectorsResult.value : [];
  const bound = doc?.session?.connectorInstanceId;
  const chosen = doc?.settings.connectorInstanceId;
  const instanceId = threadConnectorInstanceId(bound, chosen, connectors);
  const capabilities = instanceCapabilities(instanceId, connectors);
  const attachRefusal = attachmentRefusal(capabilities);
  const modelsResult = useAtomValue(connectorModelsAtom(instanceId));
  const models = AsyncResult.isSuccess(modelsResult) ? modelsResult.value : [];
  const skillsResult = useAtomValue(skillsAtom(instanceId)(projectId));
  const skills = AsyncResult.isSuccess(skillsResult) ? skillsResult.value : [];

  // The draft lives in a per-thread renderer atom, not in this component: the
  // composer unmounts on every thread switch (the next thread's detail atom
  // starts at `Initial`), and with it went the text, the mentions and any
  // pasted image — unsent, unsaved and unwarned. See `@/state/ui`.
  const { text, mentions, references, files, setText, setMentions, setReferences, setFiles } =
    useComposerDraft(threadId);
  const [error, setError] = React.useState<string | null>(null);
  const attachments = useAttachments(threadId, files, setFiles, attachRefusal);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const {
    trigger,
    activeIndex,
    slashLevel,
    setActiveIndex,
    setLevel: setSlashLevel,
    open: openTrigger,
    close: closeMenu,
    refresh: refreshTrigger,
    placeCaret,
  } = useComposerTrigger(textareaRef);

  // `turnInFlight`, not `currentTurnId`: after a turn completes with messages
  // queued, the projection goes to "running" with the id null until the
  // server's drain requests the next turn. In that window this composer would
  // have shown "Send" with no Stop button, and a message sent there would have
  // gone out unqueued and been rejected as "a turn is already running". The
  // header and the timeline already read the shared helper.
  const running = doc !== null && turnInFlight(doc);
  const steerable = canSteer(running, doc?.session?.capabilities);
  const { interrupting, interrupt } = useInterrupt(threadId, running, setError);
  const clearTokens = () => {
    setText("");
    setMentions([]);
    setReferences([]);
  };
  const { sending, send: sendDraft } = useSendDraft(threadId, attachments, setError, clearTokens);
  // The bound session's, like `steerable`: `capabilities` are the instance's.
  const compactable = canCompact(doc?.session?.capabilities);
  const compactNow = useCompactNow(threadId);
  React.useEffect(() => {
    if (compactNow.error !== null) {
      setError(compactNow.error);
    }
  }, [compactNow.error]);

  const slashItems = React.useMemo<ReadonlyArray<SlashMenuItem>>(() => {
    if (trigger?.kind !== "slash") {
      return [];
    }
    const currentModel = models.find((model) => model.id === doc?.settings.model);
    return slashMenuItems({
      level: slashLevel,
      query: trigger.query,
      skills,
      models,
      efforts: currentModel?.efforts,
      capabilities,
      canCompact: compactable,
    });
  }, [trigger, slashLevel, skills, models, doc?.settings.model, capabilities, compactable]);

  const setTextAndCaret = (nextText: string, caret: number) => {
    setText(nextText);
    placeCaret(caret);
  };

  const mentionMenus = useMentionMenus({
    instanceId,
    projectId,
    threadId,
    trigger,
    activeIndex,
    setActiveIndex,
    text,
    setText,
    setMentions,
    setReferences,
    setTextAndCaret,
  });
  const menuItemCount = mentionMenus.open ? mentionMenus.itemCount : slashItems.length;
  const recall = usePromptRecall({
    items: doc?.items ?? [],
    setText,
    setMentions,
    setReferences,
    textareaRef,
    triggerOpen: trigger !== null,
  });

  const clearDraft = () => {
    clearTokens();
    attachments.clear();
    closeMenu();
  };

  const applySlash = (item: SlashMenuItem) => {
    switch (item.action.type) {
      case "level":
        setSlashLevel(item.action.level);
        return;
      case "insert":
        if (trigger !== null) {
          const next = replaceComposerTrigger(text, trigger, item.action.text);
          setTextAndCaret(next.text, next.cursor);
        }
        return;
      case "clear-draft":
        clearDraft();
        return;
      case "compact": {
        closeMenu();
        setText((current) =>
          trigger === null ? current : replaceComposerTrigger(current, trigger, "").text.trim(),
        );
        const refusal = compactRefusal({ running, pending: compactNow.compacting });
        if (refusal === null) {
          compactNow.compact();
        } else {
          setError(refusal);
        }
        return;
      }
      case "settings":
        closeMenu();
        setText((current) =>
          trigger === null ? current : replaceComposerTrigger(current, trigger, "").text.trim(),
        );
        void dispatch({
          commandId: makeCommandId(),
          createdAt: new Date().toISOString(),
          type: "thread.settings.update",
          threadId,
          ...item.action.patch,
        }).then(
          (receipt) => setError(receiptError(receipt, "the server rejected the setting")),
          () => setError(DISPATCH_UNREACHABLE),
        );
        return;
    }
  };

  const canSend = text.trim().length > 0 || attachments.files.length > 0;
  /** The draft is the composer's; the upload and the dispatch are the hook's. */
  const send = (queueChord: boolean) => {
    if (canSend) {
      const mode = sendMode({ running, steerable, queueChord });
      sendDraft({ text: text.trim(), mentions, references, mode });
    }
  };

  useKeybindingFlag("turnRunning", running);
  useKeybindingCommand("thread.interrupt", interrupt);
  useComposerCommands({
    threadId,
    textareaRef,
    fileInputRef,
    attachments,
    clearDraft,
    submit: () => {
      closeMenu();
      send(true);
    },
  });

  const onChangeText = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setText(next);
    mentionMenus.retain(next);
    const caret = event.target.selectionStart ?? next.length;
    openTrigger(detectComposerTrigger(next, caret));
  };

  const keymapAnswers = useKeymapAnswers();
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter") {
      const action = composerEnter({
        triggerOpen: trigger !== null,
        menuItemCount,
        shiftKey: event.shiftKey,
        keymapChord: keymapChord(event, () => keymapAnswers(event.nativeEvent)),
        composing: event.nativeEvent.isComposing,
      });
      if (action === "insert" || action === "keymap") {
        return;
      }
      event.preventDefault();
      if (action === "send") {
        // An empty open menu does not hold the message hostage: close it and
        // send. A chord the keymap left alone still queues with Mod or Ctrl.
        closeMenu();
        send(event.metaKey || event.ctrlKey);
        return;
      }
      const index = Math.min(activeIndex, Math.max(0, menuItemCount - 1));
      if (mentionMenus.open) {
        mentionMenus.pickAt(index);
      } else {
        const item = slashItems[index];
        if (item !== undefined) {
          applySlash(item);
        }
      }
      return;
    }
    if (recall.onKeyDown(event)) {
      return;
    }
    if (trigger !== null) {
      const moved = menuMove(event.key, event.shiftKey, activeIndex, menuItemCount);
      if (moved !== null) {
        event.preventDefault();
        setActiveIndex(moved);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (slashLevel !== "root") {
          setSlashLevel("root");
        } else {
          closeMenu();
        }
        return;
      }
    }
  };

  /** One line under the input: a dispatch error, else what was refused. */
  const notice = error ?? attachments.rejected;

  return (
    <div
      className={cn(
        "flex w-full min-w-0 shrink-0 flex-col gap-2",
        chatWidth.classes.column,
        className,
      )}
    >
      <PendingCard threadId={threadId} doc={doc} />
      {doc === null ? null : <QueueStrip threadId={threadId} queue={doc.queue} />}
      <ComposerSurface
        dragging={attachments.dragging}
        context={
          project ? (
            <>
              <Folder variant="bold" size={16} className="shrink-0" />
              <span className="truncate" title={project.workspaceRoot}>
                {project.name}
              </span>
            </>
          ) : undefined
        }
        onSubmit={(event) => event.preventDefault()}
        {...attachments.dropHandlers}
        aria-label="Message composer"
      >
        {trigger?.kind === "slash" ? (
          <SlashMenu
            items={slashItems}
            activeIndex={activeIndex}
            onSelect={applySlash}
            onHover={setActiveIndex}
            level={slashLevel}
          />
        ) : (
          mentionMenus.menu
        )}
        <ComposerChips
          mentions={mentions}
          references={references}
          files={attachments.files}
          onRemoveMention={mentionMenus.removeMention}
          onRemoveReference={mentionMenus.removeReference}
          onRemoveFile={attachments.removeAt}
        />
        <textarea
          ref={textareaRef}
          aria-label="Message"
          placeholder={composerPlaceholder}
          data-context="composer"
          rows={2}
          value={text}
          onChange={onChangeText}
          onKeyDown={onKeyDown}
          onPaste={attachments.onPaste}
          onSelect={refreshTrigger}
          onClick={refreshTrigger}
          className={composerInputClassName}
        />
        <ComposerToolbar
          settings={<HeaderControls threadId={threadId} />}
          running={running}
          steerable={steerable}
          canSend={canSend}
          interrupting={interrupting}
          sending={sending}
          filesKey={attachments.files.length}
          fileInputRef={fileInputRef}
          onFilesPicked={attachments.add}
          onSend={() => send(false)}
          onInterrupt={interrupt}
          attachDisabledReason={attachRefusal ?? undefined}
        />
        {notice === null ? null : (
          <p className="text-xs text-destructive" role="alert">
            {notice}
          </p>
        )}
      </ComposerSurface>
    </div>
  );
}

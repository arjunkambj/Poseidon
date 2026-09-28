/**
 * What `/` shows: laid out like an empty thread — the greeting in the middle
 * and a composer pinned underneath, with the project it runs in picked beside
 * the send button.
 *
 * There is no such thing as a thread without a project, so the picker always
 * holds one — the project a thread was last started in (`useLastProject`),
 * else the first. Sending creates the thread through `useCreateThread`, sends
 * the message as its first turn, and lands on it. The id is minted when this
 * screen mounts and the draft is keyed by it, so a first message that fails
 * after the thread exists is still in the thread's own composer when the user
 * gets there.
 *
 * The model picker lists every enabled connector instance's models, and the
 * instance a model is picked under is the one the new thread runs on — it
 * rides `thread.create` with the model. Until the user picks, that is the
 * saved default model's instance, else the first enabled one's first model
 * (`defaultModelPick`). The runtime modes offered and whether attaching is
 * allowed come from that instance's capabilities, and when that instance
 * cannot run a turn the harness banner sits above the composer.
 *
 * Beside the project sits where the thread will work (`WorkspaceModePicker`):
 * the project's own folder, or a new worktree cut from a base branch. A
 * worktree start runs `start-in-worktree.ts` — create the worktree, run the
 * project's setup script with its output in the panel above the composer,
 * then create the thread with that `worktree` and send — and a failed setup
 * stops there until the user starts anyway or discards the worktree.
 *
 * The textarea opens the same `#` file, `@` plugin-and-skill and `$` skill
 * menus as a thread's composer (`useMentionMenus`, asking the instance the
 * thread will run on), and the first message carries their mentions and
 * references. `#` searches the project's folder, since the thread and any
 * worktree do not exist yet. `/` stays plain text here: its commands change a
 * thread that does not exist yet.
 *
 * Its keys are the thread composer's (`use-composer-commands`): focus, attach,
 * clear the draft, and `composer.queue`, which here simply sends — a thread
 * that does not exist yet has no turn to queue behind. Enter is decided by the
 * same `composerEnter` rule, so chorded Enter is left to the keymap.
 *
 * Around them sits the frame a thread has, for the picked project's own
 * folder (`StartThreadWorkspace`): a header with the git actions and the
 * terminal and dock toggles, the project's terminal drawer and its dock
 * (`?pane=`). The draft's id is minted here, above both, so a terminal
 * selection quoted into the chat lands in this composer's draft.
 *
 * With no server, or no projects yet, it says so (`StartThreadEmpty`).
 */

import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAppAtoms } from "@/lib/app-runtime";
import { ComposerSurface, composerInputClassName } from "@/components/composer/composer-surface";
import { startThreadPlaceholder } from "@/components/composer/composer-placeholder";
import { ComposerToolbar } from "@/components/composer/composer-toolbar";
import { ThreadSettingsControls } from "@/components/header-controls";
import { makeThreadId, type ProjectId, type ThreadId } from "@poseidon/contracts/ids";
import type { ProjectSummary, ThreadSettingsPatch } from "@poseidon/contracts/orchestration";

import { ComposerChips } from "@/components/composer/composer-chips";
import { detectComposerTrigger } from "@poseidon/client-runtime/composerTrigger";
import { useComposerTrigger } from "@/components/composer/use-composer-trigger";
import { useMentionMenus } from "@/components/composer/use-mention-menus";
import { useAttachments } from "@/components/composer/use-attachments";
import { useComposerCommands } from "@/components/composer/use-composer-commands";
import { useSendDraft } from "@/components/composer/use-send-draft";
import { HarnessHealthBanner } from "@/components/thread/harness-health-banner";
import { ProjectPicker } from "@/components/thread/project-picker";
import { startComposerKeyDown } from "@/components/thread/start-composer-keys";
import { worktreeName } from "@/components/thread/start-in-worktree";
import { useStartInWorktree } from "@/components/thread/use-start-in-worktree";
import { useStartSend } from "@/components/thread/use-start-send";
import { useTerminalHandOver } from "@/components/terminal/use-terminal-hand-over";
import { useWorkspaceChoice, WorkspaceModePicker } from "@/components/thread/workspace-mode-picker";
import { WorktreeSetupPanel } from "@/components/thread/worktree-setup-panel";
import type { DockPane } from "@/components/dock/dock-toggle";
import { StartThreadEmpty } from "@/components/thread/start-thread-empty";
import { StartThreadWorkspace } from "@/components/thread/start-thread-workspace";
import { ThreadGreeting } from "@/components/thread/thread-greeting";
import { attachmentRefusal } from "@/lib/attachment-support";
import { instanceCapabilities, threadConnectorInstanceId } from "@/lib/connector-routing";
import { defaultModelPick } from "@/lib/model-picks";
import { runtimeModeOptions } from "@/lib/runtime-modes";
import { useKeymapAnswers } from "@/lib/shortcuts";
import { useCreateThread } from "@/lib/use-create-thread";
import { useChatWidth } from "@/lib/use-chat-width";
import { useConnectionState, useProjects } from "@/state/hooks";
import { useComposerDraft, useLastProject } from "@/state/ui";

function StartComposer({
  threadId,
  projects,
  project,
  onPickProject,
}: {
  /** Minted as the page mounts: the draft is kept under it, and the thread gets it. */
  readonly threadId: ThreadId;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly project: ProjectSummary;
  readonly onPickProject: (projectId: ProjectId) => void;
}) {
  const navigate = useNavigate();
  const { create, pending } = useCreateThread();
  const chatWidth = useChatWidth();

  const { text, mentions, references, files, setText, setMentions, setReferences, setFiles } =
    useComposerDraft(threadId);
  const atoms = useAppAtoms();
  const connectorsResult = useAtomValue(atoms.connectorsAtom);
  const connectors = AsyncResult.isSuccess(connectorsResult) ? connectorsResult.value : [];
  const defaultsResult = useAtomValue(atoms.settingsAtom);
  const catalogResult = useAtomValue(atoms.modelCatalogAtom);
  const catalog = AsyncResult.isSuccess(catalogResult) ? catalogResult.value : [];
  const defaults = AsyncResult.isSuccess(defaultsResult) ? defaultsResult.value?.defaults : null;
  const [settings, setSettings] = React.useState<ThreadSettingsPatch>({});
  const initial = defaultModelPick(catalog, defaults?.model);
  const shownSettings: ThreadSettingsPatch = {
    ...(initial === null ? {} : { model: initial.model }),
    ...(initial?.connectorInstanceId == null
      ? {}
      : { connectorInstanceId: initial.connectorInstanceId }),
    ...(defaults ? { effort: defaults.effort, runtimeMode: defaults.runtimeMode } : {}),
    ...settings,
  };
  const instanceId = threadConnectorInstanceId(null, shownSettings.connectorInstanceId, connectors);
  const capabilities = instanceCapabilities(instanceId, connectors);
  const attachRefusal = attachmentRefusal(capabilities);
  const attachments = useAttachments(threadId, files, setFiles, attachRefusal);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const triggers = useComposerTrigger(textareaRef);
  const menus = useMentionMenus({
    instanceId,
    projectId: project.projectId,
    threadId: null,
    trigger: triggers.trigger,
    activeIndex: triggers.activeIndex,
    setActiveIndex: triggers.setActiveIndex,
    text,
    setText,
    setMentions,
    setReferences,
    setTextAndCaret: (next, caret) => {
      setText(next);
      triggers.placeCaret(caret);
    },
  });

  const open = () => void navigate({ to: "/t/$threadId", params: { threadId } });
  const { sending, send: sendDraft } = useSendDraft(
    threadId,
    attachments,
    (message) => {
      // The thread exists by now; the draft waits for a retry in its composer.
      if (message !== null) {
        toast.error(`The message was not sent: ${message}`);
        open();
      }
    },
    () => {
      setText("");
      setMentions([]);
      setReferences([]);
      open();
    },
  );

  const sendFirstMessage = () =>
    sendDraft({ text: text.trim(), mentions, references, mode: "start" });
  const choice = useWorkspaceChoice(project.projectId);
  const handOverTerminals = useTerminalHandOver();
  const worktreeStart = useStartInWorktree(project.projectId, {
    createThread: (worktree) =>
      create(project.projectId, { threadId, navigate: false, settings: shownSettings, worktree }),
    send: sendFirstMessage,
  });
  const { state: worktreeState } = worktreeStart;
  // From creating the worktree until the thread is started or the worktree
  // discarded, the draft and the pickers wait.
  const inWorktreeFlow = worktreeState.step !== "idle";

  const canSend = text.trim().length > 0 || attachments.files.length > 0;
  // One span from the click to the first message (`useStartSend`), so the
  // button spins through the hand-over's round trip too.
  const { starting, send } = useStartSend({
    canSend,
    blocked: pending || sending || inWorktreeFlow,
    start: async () => {
      if (choice.mode === "worktree") {
        await worktreeStart.start(worktreeName(text), choice.baseBranch);
      } else if (
        await create(project.projectId, { threadId, navigate: false, settings: shownSettings })
      ) {
        // A local thread works in the project's folder: its shells go with it.
        await handOverTerminals(project.projectId, threadId);
        sendFirstMessage();
      }
    },
  });
  const busy = starting || pending || sending || inWorktreeFlow;
  // A failed setup waits on the user (Start anyway or Discard): the button
  // stays down, but nothing is running, so it does not spin.
  const working =
    starting || pending || sending || (inWorktreeFlow && worktreeState.step !== "failed");

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const keymapAnswers = useKeymapAnswers();
  const onKeyDown = startComposerKeyDown({
    menus,
    triggers,
    keymapAnswers,
    onSend: () => void send(),
  });
  useComposerCommands({
    textareaRef,
    fileInputRef,
    attachments,
    clearDraft: () => {
      setText("");
      setMentions([]);
      setReferences([]);
      attachments.clear();
      triggers.close();
    },
    submit: () => {
      triggers.close();
      void send();
    },
  });

  return (
    <div className={`flex w-full min-w-0 flex-col gap-2 ${chatWidth.classes.column}`}>
      <HarnessHealthBanner
        summary={connectors.find((connector) => connector.connectorInstanceId === instanceId)}
      />
      <WorktreeSetupPanel
        state={worktreeState}
        liveOutput={worktreeStart.liveOutput}
        onStop={worktreeStart.stop}
        onStartAnyway={async () => {
          if (worktreeState.step === "failed") {
            await worktreeStart.startAnyway(worktreeState.worktree);
          }
        }}
        onDiscard={async () => {
          if (worktreeState.step === "failed") {
            await worktreeStart.discard(worktreeState.worktree);
          }
        }}
      />
      <ComposerSurface
        dragging={attachments.dragging}
        context={
          <>
            <ProjectPicker
              projects={projects}
              value={project.projectId}
              disabled={inWorktreeFlow}
              onPick={onPickProject}
            />
            <WorkspaceModePicker choice={choice} disabled={inWorktreeFlow} />
          </>
        }
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        {...attachments.dropHandlers}
        aria-label="New thread"
      >
        {menus.menu}
        <ComposerChips
          mentions={mentions}
          references={references}
          files={attachments.files}
          onRemoveMention={menus.removeMention}
          onRemoveReference={menus.removeReference}
          onRemoveFile={attachments.removeAt}
        />
        <textarea
          ref={textareaRef}
          aria-label="Message"
          placeholder={startThreadPlaceholder}
          data-context="composer"
          rows={2}
          autoFocus
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            menus.retain(next);
            triggers.open(detectComposerTrigger(next, event.target.selectionStart ?? next.length));
          }}
          onKeyDown={onKeyDown}
          onSelect={triggers.refresh}
          onClick={triggers.refresh}
          onPaste={attachments.onPaste}
          className={composerInputClassName}
        />
        <ComposerToolbar
          running={false}
          steerable={false}
          canSend={canSend && !busy}
          interrupting={false}
          sending={working}
          filesKey={attachments.files.length}
          fileInputRef={fileInputRef}
          onFilesPicked={attachments.add}
          onSend={() => void send()}
          onInterrupt={() => {}}
          attachDisabledReason={attachRefusal ?? undefined}
          settings={
            defaults ? (
              <ThreadSettingsControls
                settings={shownSettings}
                catalog={catalog}
                connectorInstanceId={instanceId}
                runtimeModes={runtimeModeOptions(capabilities)}
                onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
              />
            ) : undefined
          }
        />
        {attachments.rejected === null ? null : (
          <p className="text-xs text-destructive" role="alert">
            {attachments.rejected}
          </p>
        )}
      </ComposerSurface>
    </div>
  );
}

export function StartThread({ dockTab }: { readonly dockTab: DockPane | undefined }) {
  const [draftId] = React.useState(makeThreadId);
  const projects = useProjects();
  const connection = useConnectionState();
  const connected = connection.status === "connected";
  const empty = connected && projects.length === 0;

  // A pick is remembered straight away, not only once a thread is created:
  // the picker should open where the user left it.
  const [lastProject, rememberProject] = useLastProject();
  // A remembered project that has since been removed falls back to the first.
  const project = projects.find((entry) => entry.projectId === lastProject) ?? projects[0];

  if (!connected || empty || project === undefined) {
    return <StartThreadEmpty connected={connected} empty={empty} />;
  }

  // Laid out like an open thread with no messages: the greeting in the
  // middle, the composer pinned to the bottom.
  return (
    <StartThreadWorkspace projectId={project.projectId} draftId={draftId} dockTab={dockTab}>
      <ThreadGreeting project={project} />
      <div className="flex w-full shrink-0 justify-center px-6 pb-4">
        <StartComposer
          threadId={draftId}
          projects={projects}
          project={project}
          onPickProject={rememberProject}
        />
      </div>
    </StartThreadWorkspace>
  );
}

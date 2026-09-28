/**
 * The one RPC surface between the renderer and the server.
 *
 * Everything the client can ask for is here, as a single `RpcGroup` carried
 * over a WebSocket with JSON serialization. Reads that have to stay fresh are
 * streams rather than polls, and every stream can end in
 * `resnapshot-required`: the server puts a budget on each subscription, so a
 * client that falls too far behind is told to start over instead of being fed
 * an ever-growing backlog.
 *
 * Commands do not appear as individual RPCs. `orchestration.dispatch` takes the
 * whole `Command` union, which is what keeps the decider the single place where
 * a state change is decided.
 */

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { NonEmptyString, NonNegativeInt } from "./base";
import { BrowserHumanInput, BrowserState, BrowserToolStatus, DevServer } from "./browser";
import {
  AgentSkill,
  ConnectorDescriptor,
  ConnectorSummary,
  McpServerConfig,
  McpServerScope,
  ModelOption,
  PluginSummary,
  SkillSummary,
} from "./connectors";
import { EDITOR_RPC_METHODS, EditorsListRpc, EditorsOpenRpc } from "./editors";
import {
  FILES_STAT_MAX_PATHS,
  FileContent,
  FileCreated,
  FileSearchResult,
  FileStat,
} from "./files";
import { FsBrowseError, FsListing } from "./fs";
import { HarnessCommand } from "./harnessCommands";
import {
  GIT_RPC_METHODS,
  GitBranchCheckoutRpc,
  GitBranchCreateRpc,
  GitBranchesRpc,
  GitCommitRpc,
  GitPullRequestCreateRpc,
  GitPullRequestReadinessRpc,
  GitPushRpc,
  GitWorktreeCreateRpc,
  GitWorktreeListRpc,
  GitWorktreeRemoveRpc,
  GitWorktreeSetupRpc,
} from "./git";
import { GIT_REVIEW_RPC_METHODS, GitBlameRpc, GitDiscardRpc } from "./git-review";
import { ConnectorInstanceId, ProjectId, TerminalId, ThreadId, UuidV7 } from "./ids";
import {
  GitPullRequestActionRpc,
  GitPullRequestFixContextRpc,
  GitPullRequestMarksRpc,
  GitPullRequestViewRpc,
  PULL_REQUEST_RPC_METHODS,
} from "./pullRequest";
import {
  CheckpointSummary,
  Command,
  CommandReceipt,
  ProjectSummary,
  ThreadListStreamItem,
  ThreadStreamItem,
  ThreadSummary,
} from "./orchestration";
import { FileChangeKind } from "./runtime";
import {
  PLUGIN_RPC_METHODS,
  PluginsListRpc,
  PluginsOpenFolderRpc,
  PluginsSetEnabledRpc,
} from "./plugins";
import { PoseidonRpcError } from "./rpcError";
import { SCRIPT_RPC_METHODS, ScriptsDetectRpc } from "./scripts";
import { Keybinding, Settings, SettingsPatch } from "./settings";
import { THREAD_SEARCH_RPC_METHODS, ThreadsSearchMessagesRpc } from "./search";
import {
  TERMINAL_WRITE_MAX_CHARS,
  TerminalOwner,
  TerminalScriptLaunch,
  TerminalSize,
  TerminalStreamItem,
  TerminalSummary,
  terminalOwned,
} from "./terminal";

// ── Errors ─────────────────────────────────────────────────────

export { PoseidonRpcError } from "./rpcError";

// ── Payload and result schemas ─────────────────────────────────

/**
 * The first thing a client reads after connecting. `serverInstanceId` changes
 * when the server restarts, which is the signal for a reconnecting client to
 * throw away its cached snapshots rather than resume against state that no
 * longer exists.
 */
export const ServerHello = Schema.Struct({
  protocolVersion: NonNegativeInt,
  serverInstanceId: UuidV7,
});
export type ServerHello = typeof ServerHello.Type;

/** The protocol version this build speaks. Bumped when a wire shape changes incompatibly. */
export const PROTOCOL_VERSION = 3;

/**
 * The server-side budget on every stream RPC.
 *
 * A subscription that exceeds either limit fails with `resnapshot-required`
 * rather than growing a backlog the client will never catch up with. The
 * numbers live here because both ends have to agree on them: the server
 * enforces them, the client's resubscribe logic expects them, and the
 * transfer-budget test asserts against them.
 */
export const STREAM_BUDGET_ITEMS = 1000;
export const STREAM_BUDGET_BYTES = 8 * 1024 * 1024;

/**
 * How long the server holds events back before flushing them as one frame.
 * Coalescing is what keeps a fast connector from turning every token into a
 * WebSocket message.
 */
export const STREAM_COALESCE_MS = 50;

export {
  FILES_CREATE_EXTENSION,
  FILES_STAT_MAX_PATHS,
  FileContent,
  FileCreated,
  FileSearchResult,
  FileStat,
} from "./files";

export { FS_BROWSE_ENTRY_LIMIT, FsBrowseError, FsBrowseFailure, FsEntry, FsListing } from "./fs";

export { HarnessCommand } from "./harnessCommands";

/**
 * One image the composer uploaded, as it now sits under
 * `<attachments>/<threadId>/`. This is what the composer turns into the
 * `Attachment` reference it sends with the turn — the bytes stay on disk.
 *
 * `mime` is the server's sniff of the file's own magic bytes, not the name or
 * the type the browser declared; the stored file's extension
 * comes from the same sniff.
 */
export const StagedAttachment = Schema.Struct({
  path: NonEmptyString,
  name: NonEmptyString,
  mime: NonEmptyString,
  size: NonNegativeInt,
  sha256: NonEmptyString,
});
export type StagedAttachment = typeof StagedAttachment.Type;

/**
 * A staged image handed back for display. `base64` is the raw file, which the
 * timeline turns into a `data:` URL — the WebSocket is already authenticated,
 * so an attachment needs no public route and no second token.
 */
export const AttachmentBytes = Schema.Struct({
  mime: NonEmptyString,
  size: NonNegativeInt,
  base64: Schema.String,
});
export type AttachmentBytes = typeof AttachmentBytes.Type;

/** One path in `git status`, and whether its change is staged. */
export const GitFileChange = Schema.Struct({
  path: NonEmptyString,
  oldPath: Schema.optional(NonEmptyString),
  status: Schema.Literals(["added", "modified", "deleted", "renamed", "untracked"]),
  staged: Schema.Boolean,
});
export type GitFileChange = typeof GitFileChange.Type;

/**
 * `isRepository: false` is the answer for a workspace git does not track: the
 * empty `files` list then means "there is nothing to show", not "everything is
 * committed", and the changes pane can say so instead of rendering a clean
 * repo. It is optional so a producer that predates the field still decodes.
 */
export const GitStatus = Schema.Struct({
  branch: Schema.NullOr(NonEmptyString),
  upstream: Schema.NullOr(NonEmptyString),
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  isRepository: Schema.optional(Schema.Boolean),
  files: Schema.Array(GitFileChange),
});
export type GitStatus = typeof GitStatus.Type;

/** One file's unified diff, with the counts the changes pane shows in the row. */
export const GitDiffFile = Schema.Struct({
  path: NonEmptyString,
  oldPath: Schema.optional(NonEmptyString),
  kind: FileChangeKind,
  diff: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type GitDiffFile = typeof GitDiffFile.Type;

/**
 * `isRepository` carries the same meaning it does on `GitStatus`. File paths
 * are relative to the repository's top level; `prefix` is where the
 * workspace root sits under it, as `git rev-parse --show-prefix` prints it
 * (`""` at the top level, else ending in `/`).
 */
export const GitDiff = Schema.Struct({
  from: Schema.NullOr(NonEmptyString),
  to: Schema.NullOr(NonEmptyString),
  isRepository: Schema.optional(Schema.Boolean),
  prefix: Schema.optional(Schema.String),
  files: Schema.Array(GitDiffFile),
});
export type GitDiff = typeof GitDiff.Type;

export {
  BrowserFrame,
  BrowserHumanInput,
  BrowserState,
  BrowserToolStatus,
  DEV_SERVER_LIMIT,
  DevServer,
} from "./browser";

// ── Method names ───────────────────────────────────────────────

/** Every RPC method name in one place, so a rename is a single edit. */
export const RPC_METHODS = {
  serverHello: "server.hello",
  orchestrationDispatch: "orchestration.dispatch",
  projectsList: "projects.list",
  threadsList: "threads.list",
  threadsSubscribe: "threads.subscribe",
  threadsListSubscribe: "threads.listSubscribe",
  ...THREAD_SEARCH_RPC_METHODS,
  connectorsList: "connectors.list",
  connectorsModels: "connectors.models",
  connectorsDescribe: "connectors.describe",
  filesSearch: "files.search",
  filesRead: "files.read",
  filesStat: "files.stat",
  filesCreate: "files.create",
  fsBrowse: "fs.browse",
  attachmentsStage: "attachments.stage",
  attachmentsRead: "attachments.read",
  gitStatus: "git.status",
  gitDiff: "git.diff",
  ...GIT_RPC_METHODS,
  ...GIT_REVIEW_RPC_METHODS,
  ...PULL_REQUEST_RPC_METHODS,
  ...EDITOR_RPC_METHODS,
  ...SCRIPT_RPC_METHODS,
  ...PLUGIN_RPC_METHODS,
  checkpointsList: "checkpoints.list",
  browserSubscribe: "browser.subscribe",
  browserHumanInput: "browser.humanInput",
  browserDiscoverServers: "browser.discoverServers",
  browserStatus: "browser.status",
  settingsGet: "settings.get",
  settingsUpdate: "settings.update",
  settingsSubscribe: "settings.subscribe",
  connectorsSkillsList: "connectors.skills.list",
  connectorsSkillsAvailable: "connectors.skills.available",
  connectorsSkillsLink: "connectors.skills.link",
  connectorsPluginsList: "connectors.plugins.list",
  connectorsCommandsList: "connectors.commands.list",
  connectorsMcpList: "connectors.mcp.list",
  connectorsMcpAdd: "connectors.mcp.add",
  connectorsMcpRemove: "connectors.mcp.remove",
  keybindingsGet: "keybindings.get",
  keybindingsUpdate: "keybindings.update",
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClose: "terminal.close",
  terminalList: "terminal.list",
  terminalListRunning: "terminal.listRunning",
  terminalSubscribe: "terminal.subscribe",
  terminalAdopt: "terminal.adopt",
} as const;

// ── The RPCs ───────────────────────────────────────────────────

const empty = Schema.Struct({});

const ServerHelloRpc = Rpc.make(RPC_METHODS.serverHello, {
  payload: empty,
  success: ServerHello,
  error: PoseidonRpcError,
});

const OrchestrationDispatchRpc = Rpc.make(RPC_METHODS.orchestrationDispatch, {
  payload: Schema.Struct({ command: Command }),
  success: CommandReceipt,
  error: PoseidonRpcError,
});

const ProjectsListRpc = Rpc.make(RPC_METHODS.projectsList, {
  payload: empty,
  success: Schema.Array(ProjectSummary),
  error: PoseidonRpcError,
});

const ThreadsListRpc = Rpc.make(RPC_METHODS.threadsList, {
  payload: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    includeArchived: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Array(ThreadSummary),
  error: PoseidonRpcError,
});

/**
 * Subscribe to one thread. `afterSequence` is how a reconnecting client asks
 * for catch-up instead of a fresh snapshot; the server answers with
 * `resnapshot-required` when that position is no longer replayable.
 */
const ThreadsSubscribeRpc = Rpc.make(RPC_METHODS.threadsSubscribe, {
  payload: Schema.Struct({
    threadId: ThreadId,
    afterSequence: Schema.optional(NonNegativeInt),
  }),
  success: ThreadStreamItem,
  error: PoseidonRpcError,
  stream: true,
});

const ThreadsListSubscribeRpc = Rpc.make(RPC_METHODS.threadsListSubscribe, {
  payload: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    afterSequence: Schema.optional(NonNegativeInt),
  }),
  success: ThreadListStreamItem,
  error: PoseidonRpcError,
  stream: true,
});

/**
 * `refresh: true` re-runs each configured connector's probe before answering —
 * the settings page's probe button. The default returns the probes cached by
 * the last reconcile, so listing stays cheap for the model picker.
 */
const ConnectorsListRpc = Rpc.make(RPC_METHODS.connectorsList, {
  payload: Schema.Struct({ refresh: Schema.optional(Schema.Boolean) }),
  success: Schema.Array(ConnectorSummary),
  error: PoseidonRpcError,
});

const ConnectorsModelsRpc = Rpc.make(RPC_METHODS.connectorsModels, {
  payload: Schema.Struct({ instanceId: ConnectorInstanceId }),
  success: Schema.Array(ModelOption),
  error: PoseidonRpcError,
});

/** Every connector this build ships, with its metadata and config form. */
const ConnectorsDescribeRpc = Rpc.make(RPC_METHODS.connectorsDescribe, {
  payload: empty,
  success: Schema.Array(ConnectorDescriptor),
  error: PoseidonRpcError,
});

/**
 * `threadId`, on this and the other workspace reads below, reads the thread's
 * own root — its worktree, when it has one — instead of the project's.
 */
const FilesSearchRpc = Rpc.make(RPC_METHODS.filesSearch, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    query: Schema.String,
    limit: Schema.optional(NonNegativeInt),
  }),
  success: Schema.Array(FileSearchResult),
  error: PoseidonRpcError,
});

const FilesReadRpc = Rpc.make(RPC_METHODS.filesRead, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    path: NonEmptyString,
    offset: Schema.optional(NonNegativeInt),
    limit: Schema.optional(NonNegativeInt),
  }),
  success: FileContent,
  error: PoseidonRpcError,
});

/**
 * Which of up to `FILES_STAT_MAX_PATHS` paths exist inside the workspace root.
 * A relative path resolves against the root, an absolute one counts only when
 * it lies inside it. A missing, escaping or unreadable path is left out of the
 * answer rather than failing the call, so one bad candidate never costs the
 * others theirs.
 */
const FilesStatRpc = Rpc.make(RPC_METHODS.filesStat, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    paths: Schema.Array(NonEmptyString).check(Schema.isMaxLength(FILES_STAT_MAX_PATHS)),
  }),
  success: Schema.Array(FileStat),
  error: PoseidonRpcError,
});

/**
 * Writes a new Markdown file into the workspace — a plan saved from its card.
 * It only ever creates: `path` is relative to the root, stays inside it
 * (symlinks followed), ends in `FILES_CREATE_EXTENSION`, and must not exist
 * yet — an existing file fails `conflict` and is left as it was, anything
 * else refused fails `invalid`. Missing folders on the way are made.
 */
const FilesCreateRpc = Rpc.make(RPC_METHODS.filesCreate, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    path: NonEmptyString,
    content: Schema.String,
  }),
  success: FileCreated,
  error: PoseidonRpcError,
});

/**
 * Lists the subfolders of one directory on the machine the *server* runs on.
 *
 * Deliberately not a project RPC: this is what the folder picker browses before
 * a project exists, and the server is the only side that can see the disk once
 * the renderer is a browser tab or, later, a remote client. `path` omitted means
 * the server user's home directory, which is where a picker opens.
 */
const FsBrowseRpc = Rpc.make(RPC_METHODS.fsBrowse, {
  payload: Schema.Struct({
    path: Schema.optional(NonEmptyString),
    showHidden: Schema.optional(Schema.Boolean),
  }),
  success: FsListing,
  error: FsBrowseError,
});

/**
 * Uploads one composer image and writes it under the thread's attachments
 * directory. The reply is a reference the turn can carry; the bytes are not
 * echoed back and never enter the event log.
 */
const AttachmentsStageRpc = Rpc.make(RPC_METHODS.attachmentsStage, {
  payload: Schema.Struct({
    threadId: ThreadId,
    name: NonEmptyString,
    base64: Schema.String,
  }),
  success: StagedAttachment,
  error: PoseidonRpcError,
});

/** Reads a staged attachment back, for a timeline thumbnail. */
const AttachmentsReadRpc = Rpc.make(RPC_METHODS.attachmentsRead, {
  payload: Schema.Struct({ threadId: ThreadId, path: NonEmptyString }),
  success: AttachmentBytes,
  error: PoseidonRpcError,
});

const GitStatusRpc = Rpc.make(RPC_METHODS.gitStatus, {
  payload: Schema.Struct({ projectId: ProjectId, threadId: Schema.optional(ThreadId) }),
  success: GitStatus,
  error: PoseidonRpcError,
});

/**
 * A diff of the worktree, or between two checkpoint refs. Omitting both ends
 * means "the working tree against HEAD", which is what the changes pane opens
 * on. `mergeBase` is the "branch against its base" comparison: the working
 * tree, uncommitted and untracked work included, against `git merge-base HEAD
 * <mergeBase>`, so the base's own later commits never show as reverted. It
 * takes the place of `from` and cannot be combined with `to`.
 * `ignoreWhitespace` diffs with `-w`: a file whose change is whitespace alone
 * drops out, or stays listed with an empty `diff` and no counts.
 */
const GitDiffRpc = Rpc.make(RPC_METHODS.gitDiff, {
  payload: Schema.Struct({
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    from: Schema.optional(NonEmptyString),
    to: Schema.optional(NonEmptyString),
    mergeBase: Schema.optional(NonEmptyString),
    path: Schema.optional(NonEmptyString),
    ignoreWhitespace: Schema.optional(Schema.Boolean),
  }),
  success: GitDiff,
  error: PoseidonRpcError,
});

/**
 * The checkpoints that still exist in the repository for one thread, read in
 * that thread's root. The timeline's own list is a fold of
 * `thread.checkpoint.created`, which cannot know about a ref removed outside
 * the app (a prune, a re-clone); intersecting the two is what stops the pane
 * offering a restore that can only fail.
 */
const CheckpointsListRpc = Rpc.make(RPC_METHODS.checkpointsList, {
  payload: Schema.Struct({ projectId: ProjectId, threadId: ThreadId }),
  success: Schema.Array(CheckpointSummary),
  error: PoseidonRpcError,
});

const BrowserSubscribeRpc = Rpc.make(RPC_METHODS.browserSubscribe, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: BrowserState,
  error: PoseidonRpcError,
  stream: true,
});

const BrowserHumanInputRpc = Rpc.make(RPC_METHODS.browserHumanInput, {
  payload: Schema.Struct({ threadId: ThreadId, input: BrowserHumanInput }),
  success: empty,
  error: PoseidonRpcError,
});

/**
 * The dev servers running under the thread's project, for the address bar's
 * suggestions and the empty pane. On demand only — the server caches an
 * answer for a few seconds and never scans in the background.
 */
const BrowserDiscoverServersRpc = Rpc.make(RPC_METHODS.browserDiscoverServers, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: Schema.Array(DevServer),
  error: PoseidonRpcError,
});

/** The browser tool's mode and agent-browser's install state, fixed at server start. */
const BrowserStatusRpc = Rpc.make(RPC_METHODS.browserStatus, {
  payload: empty,
  success: BrowserToolStatus,
  error: PoseidonRpcError,
});

const SettingsGetRpc = Rpc.make(RPC_METHODS.settingsGet, {
  payload: empty,
  success: Settings,
  error: PoseidonRpcError,
});

const SettingsUpdateRpc = Rpc.make(RPC_METHODS.settingsUpdate, {
  payload: Schema.Struct({ patch: SettingsPatch }),
  success: Settings,
  error: PoseidonRpcError,
});

const SettingsSubscribeRpc = Rpc.make(RPC_METHODS.settingsSubscribe, {
  payload: empty,
  success: Settings,
  error: PoseidonRpcError,
  stream: true,
});

/**
 * The per-instance extensions (`connector-sdk/src/extensions.ts`). Each one
 * fails `unavailable` on an instance that does not carry the extension, which
 * `ConnectorSummary.extensions` tells the renderer up front. `projectId` adds
 * that project's scope to the user one.
 */
const ConnectorsSkillsListRpc = Rpc.make(RPC_METHODS.connectorsSkillsList, {
  payload: Schema.Struct({
    instanceId: ConnectorInstanceId,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Array(SkillSummary),
  error: PoseidonRpcError,
});

/** Skills in a shared folder the instance does not load yet; empty when it offers none. */
const ConnectorsSkillsAvailableRpc = Rpc.make(RPC_METHODS.connectorsSkillsAvailable, {
  payload: Schema.Struct({ instanceId: ConnectorInstanceId }),
  success: Schema.Array(AgentSkill),
  error: PoseidonRpcError,
});

/** Links one available skill into the instance's user skills; answers the rest. */
const ConnectorsSkillsLinkRpc = Rpc.make(RPC_METHODS.connectorsSkillsLink, {
  payload: Schema.Struct({ instanceId: ConnectorInstanceId, entry: NonEmptyString }),
  success: Schema.Array(AgentSkill),
  error: PoseidonRpcError,
});

/** Plugins the instance has installed, in the user scope plus the project's. */
const ConnectorsPluginsListRpc = Rpc.make(RPC_METHODS.connectorsPluginsList, {
  payload: Schema.Struct({
    instanceId: ConnectorInstanceId,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Array(PluginSummary),
  error: PoseidonRpcError,
});

/** The harness's own slash commands, for the composer's `/` menu. */
const ConnectorsCommandsListRpc = Rpc.make(RPC_METHODS.connectorsCommandsList, {
  payload: Schema.Struct({
    instanceId: ConnectorInstanceId,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Array(HarnessCommand),
  error: PoseidonRpcError,
});

const ConnectorsMcpListRpc = Rpc.make(RPC_METHODS.connectorsMcpList, {
  payload: Schema.Struct({
    instanceId: ConnectorInstanceId,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Array(McpServerConfig),
  error: PoseidonRpcError,
});

/** Adds or replaces one server the instance manages; answers the whole list. */
const ConnectorsMcpAddRpc = Rpc.make(RPC_METHODS.connectorsMcpAdd, {
  payload: Schema.Struct({
    instanceId: ConnectorInstanceId,
    projectId: Schema.optional(ProjectId),
    server: McpServerConfig,
  }),
  success: Schema.Array(McpServerConfig),
  error: PoseidonRpcError,
});

const ConnectorsMcpRemoveRpc = Rpc.make(RPC_METHODS.connectorsMcpRemove, {
  payload: Schema.Struct({
    instanceId: ConnectorInstanceId,
    projectId: Schema.optional(ProjectId),
    scope: McpServerScope,
    name: NonEmptyString,
  }),
  success: Schema.Array(McpServerConfig),
  error: PoseidonRpcError,
});

/**
 * The user's keybinding overrides, not the whole keymap: the renderer layers
 * them on `DEFAULT_KEYBINDINGS` with `resolveKeymap`. The shape is the one a
 * full table had, so an older peer on either end degrades safely — each row it
 * sends replaces only its own command's defaults.
 */
const KeybindingsGetRpc = Rpc.make(RPC_METHODS.keybindingsGet, {
  payload: empty,
  success: Schema.Array(Keybinding),
  error: PoseidonRpcError,
});

/** Replaces the stored overrides wholesale and answers with the new ones. */
const KeybindingsUpdateRpc = Rpc.make(RPC_METHODS.keybindingsUpdate, {
  payload: Schema.Struct({ keybindings: Schema.Array(Keybinding) }),
  success: Schema.Array(Keybinding),
  error: PoseidonRpcError,
});

/**
 * The integrated terminal (`./terminal`). Every call names the terminal's
 * owner — a thread, or a project that has no thread yet — as well as the
 * terminal, so the server can refuse a terminal that belongs to another owner.
 * `terminal.write` runs whatever it is sent in the user's shell; it rides the
 * same authenticated loopback socket as `orchestration.dispatch`. A `script`
 * on `terminal.open` runs its command the same way, over the same socket, so
 * it lets a client do nothing `terminal.write` does not already.
 */
const terminalRef = { terminalId: TerminalId };

/**
 * Starts the shell, or answers the one already running under this id — the
 * client mints the id, so a retried or repeated open never starts a second.
 */
const TerminalOpenRpc = Rpc.make(RPC_METHODS.terminalOpen, {
  payload: terminalOwned({
    ...terminalRef,
    ...TerminalSize.fields,
    title: Schema.optional(NonEmptyString),
    script: Schema.optional(TerminalScriptLaunch),
  }),
  success: TerminalSummary,
  error: PoseidonRpcError,
});

/** Input for the shell: typed keys, a paste. */
const TerminalWriteRpc = Rpc.make(RPC_METHODS.terminalWrite, {
  payload: terminalOwned({
    ...terminalRef,
    data: Schema.String.check(Schema.isMaxLength(TERMINAL_WRITE_MAX_CHARS)),
  }),
  success: empty,
  error: PoseidonRpcError,
});

const TerminalResizeRpc = Rpc.make(RPC_METHODS.terminalResize, {
  payload: terminalOwned({ ...terminalRef, ...TerminalSize.fields }),
  success: empty,
  error: PoseidonRpcError,
});

/** Kills the shell and forgets the terminal, output and all. */
const TerminalCloseRpc = Rpc.make(RPC_METHODS.terminalClose, {
  payload: terminalOwned(terminalRef),
  success: empty,
  error: PoseidonRpcError,
});

/** The owner's terminals, exited ones included, oldest first. */
const TerminalListRpc = Rpc.make(RPC_METHODS.terminalList, {
  payload: TerminalOwner,
  success: Schema.Array(TerminalSummary),
  error: PoseidonRpcError,
});

/** Every thread's terminals still running a shell, in one call: the sidebar rows' marks. */
const TerminalListRunningRpc = Rpc.make(RPC_METHODS.terminalListRunning, {
  payload: empty,
  success: Schema.Array(TerminalSummary),
  error: PoseidonRpcError,
});

/** A snapshot with the recent scrollback, then live output; see `TerminalStreamItem`. */
const TerminalSubscribeRpc = Rpc.make(RPC_METHODS.terminalSubscribe, {
  payload: terminalOwned(terminalRef),
  success: TerminalStreamItem,
  error: PoseidonRpcError,
  stream: true,
});

/**
 * Hands every terminal a project owns — running or exited, scrollback and ids
 * intact — to a thread just started from the New task page, and answers with
 * them as the thread's. The server enforces what "just started" means: the
 * project exists, and the thread is live (not archived or deleted), the
 * project's, local (no worktree, so it works in the folder those shells run
 * in) and not yet started (no turn running or queued, nothing in its
 * timeline). Anything else is refused and the shells stay the project's.
 * Nothing to hand over answers an empty list. The client calls it right after
 * `thread.create` and before the first message, so the thread's drawer finds
 * them on its first listing.
 */
const TerminalAdoptRpc = Rpc.make(RPC_METHODS.terminalAdopt, {
  payload: Schema.Struct({ projectId: ProjectId, threadId: ThreadId }),
  success: Schema.Array(TerminalSummary),
  error: PoseidonRpcError,
});

export const PoseidonRpcGroup = RpcGroup.make(
  ServerHelloRpc,
  OrchestrationDispatchRpc,
  ProjectsListRpc,
  ThreadsListRpc,
  ThreadsSubscribeRpc,
  ThreadsListSubscribeRpc,
  ThreadsSearchMessagesRpc,
  ConnectorsListRpc,
  ConnectorsModelsRpc,
  ConnectorsDescribeRpc,
  FilesSearchRpc,
  FilesReadRpc,
  FilesStatRpc,
  FilesCreateRpc,
  FsBrowseRpc,
  AttachmentsStageRpc,
  AttachmentsReadRpc,
  GitStatusRpc,
  GitDiffRpc,
  GitBranchesRpc,
  GitBranchCreateRpc,
  GitBranchCheckoutRpc,
  GitCommitRpc,
  GitPushRpc,
  GitPullRequestCreateRpc,
  GitPullRequestReadinessRpc,
  GitPullRequestViewRpc,
  GitPullRequestMarksRpc,
  GitPullRequestActionRpc,
  GitPullRequestFixContextRpc,
  GitWorktreeCreateRpc,
  GitWorktreeListRpc,
  GitWorktreeRemoveRpc,
  GitWorktreeSetupRpc,
  GitDiscardRpc,
  GitBlameRpc,
  EditorsListRpc,
  EditorsOpenRpc,
  ScriptsDetectRpc,
  CheckpointsListRpc,
  BrowserSubscribeRpc,
  BrowserHumanInputRpc,
  BrowserDiscoverServersRpc,
  BrowserStatusRpc,
  SettingsGetRpc,
  SettingsUpdateRpc,
  SettingsSubscribeRpc,
  ConnectorsSkillsListRpc,
  ConnectorsSkillsAvailableRpc,
  ConnectorsSkillsLinkRpc,
  ConnectorsPluginsListRpc,
  ConnectorsCommandsListRpc,
  ConnectorsMcpListRpc,
  ConnectorsMcpAddRpc,
  ConnectorsMcpRemoveRpc,
  PluginsListRpc,
  PluginsSetEnabledRpc,
  PluginsOpenFolderRpc,
  KeybindingsGetRpc,
  KeybindingsUpdateRpc,
  TerminalOpenRpc,
  TerminalWriteRpc,
  TerminalResizeRpc,
  TerminalCloseRpc,
  TerminalListRpc,
  TerminalListRunningRpc,
  TerminalSubscribeRpc,
  TerminalAdoptRpc,
);

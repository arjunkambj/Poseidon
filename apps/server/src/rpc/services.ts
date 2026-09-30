/**
 * Service interfaces behind the RPC surface. Each surface the orchestration
 * layer does not own itself — connectors, the browser, the terminal, files and
 * git, the harness's own config — is a Tag with an in-memory implementation here, so
 * the server runs end to end with any of them swapped for a fake. The real
 * implementations provide the layer; none of them touches this contract.
 */

import type {
  AgentSkill,
  ConnectorDescriptor,
  ConnectorSummary,
  McpServerConfig,
  McpServerScope,
  ModelOption,
  PluginSummary,
  SkillSummary,
} from "@poseidon/contracts/connectors";
import type {
  BrowserHumanInput,
  BrowserState,
  BrowserToolStatus,
  DevServer,
  FileContent,
  FileCreated,
  FileSearchResult,
  FileStat,
  FsListing,
  GitDiff,
  GitStatus,
  HarnessCommand,
} from "@poseidon/contracts/rpc";
import { FsBrowseError, PoseidonRpcError } from "@poseidon/contracts/rpc";
import type {
  GitBranchList,
  GitCommitResult,
  GitPullRequestReadiness,
  GitPullRequestResult,
  GitPushResult,
  GitWorktreeCreated,
  GitWorktreeInfo,
  WorktreeSetupFrame,
} from "@poseidon/contracts/git";
import type { GitBlame } from "@poseidon/contracts/git-review";
import type { DetectedEditor, EditorId } from "@poseidon/contracts/editors";
import type { CheckpointSummary } from "@poseidon/contracts/orchestration";
import type { MessageSearchHit } from "@poseidon/contracts/search";
import type { Settings, SettingsPatch } from "@poseidon/contracts/settings";
import type { ConnectorInstanceId, ProjectId, TerminalId, ThreadId } from "@poseidon/contracts/ids";
import type {
  TerminalOwner,
  TerminalScriptLaunch,
  TerminalStreamItem,
  TerminalSummary,
} from "@poseidon/contracts/terminal";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PERMISSION_RULES_KEY, readRules, writeRules } from "../permissions/PermissionService";
import { layer as migrationsLayer } from "../persistence/Migrations";
import type { BrowserCallOutcome } from "../browser/tools";
import type { PullRequestMethods } from "./pullRequestService";
import { loadSettingsRow, SETTINGS_ROW_KEY, SETTINGS_UNREADABLE_ROW_KEY } from "./settingsRow";

// ── Server identity ────────────────────────────────────────────

/** Minted once at boot; a changed value tells clients to resnapshot. */
export class ServerIdentity extends Context.Service<
  ServerIdentity,
  {
    readonly serverInstanceId: string;
  }
>()("server/rpc/ServerIdentity") {}

// ── Connectors ─────────────────────────────────────────────────

export class ConnectorCatalog extends Context.Service<
  ConnectorCatalog,
  {
    /** `refresh` re-runs each connector's probe before answering. */
    readonly list: (refresh?: boolean) => Effect.Effect<ReadonlyArray<ConnectorSummary>>;
    /** The list as it changes: registrations and every probe that lands. */
    readonly changes: Stream.Stream<ReadonlyArray<ConnectorSummary>>;
    readonly models: (instanceId: ConnectorInstanceId) => Effect.Effect<ReadonlyArray<ModelOption>>;
    /** Every connector this build ships, configured or not, with its metadata and form. */
    readonly describe: Effect.Effect<ReadonlyArray<ConnectorDescriptor>>;
  }
>()("server/rpc/ConnectorCatalog") {
  static readonly empty = Layer.succeed(
    ConnectorCatalog,
    ConnectorCatalog.of({
      list: () => Effect.succeed([]),
      // Held open: a feed that ended would have the client subscribe again.
      changes: Stream.concat(Stream.make([]), Stream.never),
      models: () => Effect.succeed([]),
      describe: Effect.succeed([]),
    }),
  );
}

// ── Files ──────────────────────────────────────────────────────

/**
 * Which directory a workspace read runs in: the named thread's own root (its
 * worktree, when it has one), or the project's root when no thread is named.
 */
export interface WorkspaceScope {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
}

export class FileService extends Context.Service<
  FileService,
  {
    readonly search: (
      scope: WorkspaceScope,
      query: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<FileSearchResult>, PoseidonRpcError>;
    readonly read: (
      scope: WorkspaceScope,
      path: string,
      offset?: number,
      limit?: number,
    ) => Effect.Effect<FileContent, PoseidonRpcError>;
    /** Which of `paths` exist inside the root; a path that does not is absent, not an error. */
    readonly stat: (
      scope: WorkspaceScope,
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<FileStat>, PoseidonRpcError>;
    /** A new `.md` file inside the root; never overwrites (`../git/create.ts`). */
    readonly create: (
      scope: WorkspaceScope,
      path: string,
      content: string,
    ) => Effect.Effect<FileCreated, PoseidonRpcError>;
  }
>()("server/rpc/FileService") {
  static readonly empty = Layer.succeed(
    FileService,
    FileService.of({
      search: (_scope, _query, _limit) => Effect.succeed([]),
      read: (_scope, path) => Effect.succeed({ path, text: "", totalLines: 0, truncated: false }),
      stat: (_scope, _paths) => Effect.succeed([]),
      create: (_scope, path) =>
        Effect.fail(
          new PoseidonRpcError({ code: "unavailable", message: `cannot create ${path}` }),
        ),
    }),
  );
}

// ── Directory browsing (the folder picker) ─────────────────────

/**
 * `fs.browse` behind a Tag like everything else, though it has only ever had
 * one implementation: the picker's listing is a filesystem read that a test
 * (and, later, a host that is not this machine) has every reason to replace
 * without the handler knowing.
 */
export class DirectoryBrowser extends Context.Service<
  DirectoryBrowser,
  {
    readonly browse: (input: {
      /** Absolute. Omitted means the server user's home directory. */
      readonly path?: string | undefined;
      readonly showHidden?: boolean | undefined;
    }) => Effect.Effect<FsListing, FsBrowseError>;
  }
>()("server/rpc/DirectoryBrowser") {}

// ── Git ────────────────────────────────────────────────────────

const gitUnavailable = new PoseidonRpcError({
  code: "unavailable",
  message: "git is not available on this server",
});

export class GitService extends Context.Service<
  GitService,
  {
    readonly status: (scope: WorkspaceScope) => Effect.Effect<GitStatus, PoseidonRpcError>;
    readonly diff: (
      scope: WorkspaceScope,
      options: {
        readonly from?: string;
        readonly to?: string;
        readonly path?: string;
        /** Diff the working tree against `git merge-base HEAD <mergeBase>`. */
        readonly mergeBase?: string;
        /** Diff with `-w`, so whitespace-only changes drop out. */
        readonly ignoreWhitespace?: boolean;
      },
    ) => Effect.Effect<GitDiff, PoseidonRpcError>;
    /**
     * Discards the change to `paths` (top-relative) back to `source`, the
     * merge base with `mergeBase`, or `HEAD`; everything uncommitted when
     * `paths` is omitted. `invalid` for an unsafe path, `conflict` while a
     * turn or restore runs in the same root.
     */
    readonly discard: (
      scope: WorkspaceScope,
      options: {
        readonly paths?: ReadonlyArray<string> | undefined;
        readonly source?: string | undefined;
        readonly mergeBase?: string | undefined;
      },
    ) => Effect.Effect<void, PoseidonRpcError>;
    /** `git blame` of the working file at a top-relative `path`, optionally a line range. */
    readonly blame: (
      scope: WorkspaceScope,
      options: {
        readonly path: string;
        readonly startLine?: number | undefined;
        readonly endLine?: number | undefined;
      },
    ) => Effect.Effect<GitBlame, PoseidonRpcError>;
    readonly branches: (scope: WorkspaceScope) => Effect.Effect<GitBranchList, PoseidonRpcError>;
    /** Cuts an untracked branch, and switches to it when `checkout` is set. */
    readonly createBranch: (
      scope: WorkspaceScope,
      options: { readonly name: string; readonly from?: string; readonly checkout: boolean },
    ) => Effect.Effect<GitBranchList, PoseidonRpcError>;
    /** `conflict` on a dirty tracked tree or while a turn runs in the same root. */
    readonly checkout: (
      scope: WorkspaceScope,
      branch: string,
    ) => Effect.Effect<GitBranchList, PoseidonRpcError>;
    /**
     * Commits everything, or only `paths`, as the user. `conflict` when nothing
     * is staged, a hook refuses, or a turn runs in the same root.
     */
    readonly commit: (
      scope: WorkspaceScope,
      options: { readonly message: string; readonly paths?: ReadonlyArray<string> | undefined },
    ) => Effect.Effect<GitCommitResult, PoseidonRpcError>;
    /** Pushes the current branch, setting its upstream on the first push. */
    readonly push: (scope: WorkspaceScope) => Effect.Effect<GitPushResult, PoseidonRpcError>;
    /** Opens (or finds) the current branch's pull request through the GitHub CLI. */
    readonly createPullRequest: (
      scope: WorkspaceScope,
      options: { readonly title: string; readonly body: string; readonly base?: string },
    ) => Effect.Effect<GitPullRequestResult, PoseidonRpcError>;
    /** Why `gh` cannot open a pull request from the workspace, `null` when it can. */
    readonly pullRequestReadiness: (
      scope: WorkspaceScope,
    ) => Effect.Effect<GitPullRequestReadiness, PoseidonRpcError>;
    /**
     * Cuts a worktree for a new thread under the Poseidon home, on a branch
     * named from the settings' prefix and `name`, from `baseBranch` or the
     * default branch.
     */
    readonly createWorktree: (
      projectId: ProjectId,
      options: { readonly name: string; readonly baseBranch?: string | undefined },
    ) => Effect.Effect<GitWorktreeCreated, PoseidonRpcError>;
    readonly listWorktrees: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<GitWorktreeInfo>, PoseidonRpcError>;
    /**
     * Removes one of the project's worktrees, keeping its branch. `conflict`
     * while a thread works in it, or when it holds work `force` would lose.
     */
    readonly removeWorktree: (
      projectId: ProjectId,
      options: { readonly path: string; readonly force: boolean },
    ) => Effect.Effect<void, PoseidonRpcError>;
    /** Runs the project's configured setup script in one of its worktrees. */
    readonly setupWorktree: (
      projectId: ProjectId,
      path: string,
    ) => Stream.Stream<WorktreeSetupFrame, PoseidonRpcError>;
    /** The checkpoint refs that still exist for a thread, read in its root, oldest first. */
    readonly checkpoints: (
      projectId: ProjectId,
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<CheckpointSummary>, PoseidonRpcError>;
  } & PullRequestMethods
>()("server/rpc/GitService") {
  static readonly empty = Layer.succeed(
    GitService,
    GitService.of({
      status: (_scope) =>
        Effect.succeed({ branch: null, upstream: null, ahead: 0, behind: 0, files: [] }),
      diff: (_scope, options) =>
        Effect.succeed({ from: options.from ?? null, to: options.to ?? null, files: [] }),
      checkpoints: () => Effect.succeed([]),
      discard: () => Effect.fail(gitUnavailable),
      blame: () => Effect.fail(gitUnavailable),
      branches: () => Effect.fail(gitUnavailable),
      createBranch: () => Effect.fail(gitUnavailable),
      checkout: () => Effect.fail(gitUnavailable),
      commit: () => Effect.fail(gitUnavailable),
      push: () => Effect.fail(gitUnavailable),
      createPullRequest: () => Effect.fail(gitUnavailable),
      pullRequestReadiness: () => Effect.fail(gitUnavailable),
      viewPullRequest: () =>
        Effect.succeed({ state: "unavailable" as const, reason: gitUnavailable.message }),
      pullRequestMarks: () => Effect.succeed({ marks: [] }),
      pullRequestAction: () => Effect.fail(gitUnavailable),
      pullRequestFixContext: () => Effect.fail(gitUnavailable),
      createWorktree: () => Effect.fail(gitUnavailable),
      listWorktrees: () => Effect.fail(gitUnavailable),
      removeWorktree: () => Effect.fail(gitUnavailable),
      setupWorktree: () => Stream.fail(gitUnavailable),
    }),
  );
}

// ── Browser ────────────────────────────────────────────────────

/**
 * The browser pane's session service. `subscribe`/`humanInput` are the wire
 * surface; `callTool` is the MCP layer's entry into the same per-thread
 * serialized queue (tool failures and human interruption come back inside the
 * outcome); `teardown` is the thread-close hook; `status` is what the
 * Browser settings page shows — the mode and agent-browser's version.
 */
export class BrowserService extends Context.Service<
  BrowserService,
  {
    readonly subscribe: (threadId: ThreadId) => Stream.Stream<BrowserState>;
    /** `unknown` error: the RPC handler maps whatever an implementation fails with. */
    readonly humanInput: (
      threadId: ThreadId,
      input: BrowserHumanInput,
    ) => Effect.Effect<void, unknown>;
    readonly callTool: (
      threadId: ThreadId,
      name: string,
      args: unknown,
    ) => Effect.Effect<BrowserCallOutcome>;
    readonly teardown: (threadId: ThreadId) => Effect.Effect<void>;
    readonly status: BrowserToolStatus;
  }
>()("server/rpc/BrowserService") {
  static readonly empty = Layer.succeed(
    BrowserService,
    BrowserService.of({
      subscribe: (threadId) =>
        Stream.make({
          threadId,
          status: "stopped" as const,
          mode: "disabled" as const,
          url: null,
          title: null,
          frame: null,
        }),
      humanInput: () => Effect.void,
      callTool: () => Effect.succeed({ kind: "error", message: "browser service unavailable" }),
      teardown: () => Effect.void,
      status: { mode: "disabled", installed: false, version: null },
    }),
  );
}

/**
 * `browser.discoverServers` behind a Tag of its own: the real one runs `lsof`
 * and probes loopback ports (`browser/discovery.ts`), which no test of the
 * RPC surface wants to do. A failure is an empty list — a suggestion the
 * pane cannot make is not an error worth showing.
 */
export class DevServerDiscovery extends Context.Service<
  DevServerDiscovery,
  {
    readonly discover: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<DevServer>>;
  }
>()("server/rpc/DevServerDiscovery") {
  static readonly empty = Layer.succeed(
    DevServerDiscovery,
    DevServerDiscovery.of({ discover: () => Effect.succeed([]) }),
  );
}

// ── Editors ────────────────────────────────────────────────────

/**
 * The editors, file manager and terminal installed where the server runs, and
 * the one launch `editors.open` makes (`../editors/EditorLauncher.ts`). `open`
 * resolves `path` inside the scope's workspace root and refuses an app `list`
 * would not name; the empty one has nothing installed.
 */
export class EditorLauncher extends Context.Service<
  EditorLauncher,
  {
    readonly list: Effect.Effect<ReadonlyArray<DetectedEditor>>;
    readonly open: (
      scope: WorkspaceScope,
      request: {
        readonly editor: EditorId;
        readonly path?: string | undefined;
        readonly line?: number | undefined;
        readonly reveal?: boolean | undefined;
      },
    ) => Effect.Effect<void, PoseidonRpcError>;
  }
>()("server/rpc/EditorLauncher") {
  static readonly empty = Layer.succeed(
    EditorLauncher,
    EditorLauncher.of({
      list: Effect.succeed([]),
      open: () =>
        Effect.fail(
          new PoseidonRpcError({ code: "unavailable", message: "no editors on this server" }),
        ),
    }),
  );
}

// ── Message search ─────────────────────────────────────────────

/**
 * Threads whose user or assistant text contains a query, answered from the
 * projection's message index (`../persistence/MessageSearch.ts`). The empty
 * one finds nothing.
 */
export class MessageSearch extends Context.Service<
  MessageSearch,
  {
    readonly search: (
      query: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<MessageSearchHit>, PoseidonRpcError>;
  }
>()("server/rpc/MessageSearch") {
  static readonly empty = Layer.succeed(
    MessageSearch,
    MessageSearch.of({ search: () => Effect.succeed([]) }),
  );
}

// ── Terminal ───────────────────────────────────────────────────

/**
 * The integrated terminal's shells, each owned by a thread, a project —
 * before any thread exists — or home — before any project exists
 * (`TerminalOwner`). Every call names the owner as well as the terminal, and
 * an implementation answers `not-found` for a terminal that belongs to a
 * different owner. `subscribe` is the wire's output stream (a snapshot with
 * the scrollback, then live output); `teardownThread` is the thread-close hook
 * that kills every shell the thread still holds.
 */
export class TerminalService extends Context.Service<
  TerminalService,
  {
    readonly open: (
      input: TerminalOwner & {
        readonly terminalId: TerminalId;
        readonly cols: number;
        readonly rows: number;
        readonly title?: string | undefined;
        readonly script?: TerminalScriptLaunch | undefined;
      },
    ) => Effect.Effect<TerminalSummary, PoseidonRpcError>;
    readonly write: (
      owner: TerminalOwner,
      terminalId: TerminalId,
      data: string,
    ) => Effect.Effect<void, PoseidonRpcError>;
    readonly resize: (
      owner: TerminalOwner,
      terminalId: TerminalId,
      cols: number,
      rows: number,
    ) => Effect.Effect<void, PoseidonRpcError>;
    readonly close: (
      owner: TerminalOwner,
      terminalId: TerminalId,
    ) => Effect.Effect<void, PoseidonRpcError>;
    readonly list: (
      owner: TerminalOwner,
    ) => Effect.Effect<ReadonlyArray<TerminalSummary>, PoseidonRpcError>;
    /** Every thread's terminals that still run a shell, across all threads. */
    readonly listRunning: () => Effect.Effect<ReadonlyArray<TerminalSummary>>;
    readonly subscribe: (
      owner: TerminalOwner,
      terminalId: TerminalId,
    ) => Stream.Stream<TerminalStreamItem, PoseidonRpcError>;
    readonly teardownThread: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * Hands every terminal the project owns to a local thread of that
     * project (`terminal.adopt`), answering with them as the thread's.
     */
    readonly adopt: (
      projectId: ProjectId,
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<TerminalSummary>, PoseidonRpcError>;
  }
>()("server/rpc/TerminalService") {
  /** No shells at all: reads answer nothing, and anything that would start or touch one fails. */
  static readonly empty = Layer.succeed(
    TerminalService,
    TerminalService.of({
      open: () => Effect.fail(terminalUnavailable()),
      write: () => Effect.fail(terminalUnavailable()),
      resize: () => Effect.fail(terminalUnavailable()),
      close: () => Effect.fail(terminalUnavailable()),
      list: () => Effect.succeed([]),
      listRunning: () => Effect.succeed([]),
      subscribe: () => Stream.empty,
      teardownThread: () => Effect.void,
      adopt: () => Effect.succeed([]),
    }),
  );
}

const terminalUnavailable = () =>
  new PoseidonRpcError({ code: "unavailable", message: "terminal service unavailable" });

// ── Connector extensions ───────────────────────────────────────

/**
 * The per-instance extensions behind `connectors.skills.*`,
 * `connectors.plugins.*`, `connectors.commands.*` and `connectors.mcp.*`. The real layer (`settings/ConnectorExtensions.ts`)
 * resolves the instance and the project's workspace root, then calls the
 * connector; the empty one answers every read with nothing.
 */
export class ConnectorExtensions extends Context.Service<
  ConnectorExtensions,
  {
    readonly skillsList: (
      instanceId: ConnectorInstanceId,
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<SkillSummary>, PoseidonRpcError>;
    readonly skillsAvailable: (
      instanceId: ConnectorInstanceId,
    ) => Effect.Effect<ReadonlyArray<AgentSkill>, PoseidonRpcError>;
    readonly skillsLink: (
      instanceId: ConnectorInstanceId,
      entry: string,
    ) => Effect.Effect<ReadonlyArray<AgentSkill>, PoseidonRpcError>;
    readonly pluginsList: (
      instanceId: ConnectorInstanceId,
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<PluginSummary>, PoseidonRpcError>;
    readonly commandsList: (
      instanceId: ConnectorInstanceId,
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<HarnessCommand>, PoseidonRpcError>;
    readonly mcpList: (
      instanceId: ConnectorInstanceId,
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<McpServerConfig>, PoseidonRpcError>;
    readonly mcpAdd: (
      instanceId: ConnectorInstanceId,
      projectId: ProjectId | undefined,
      server: McpServerConfig,
    ) => Effect.Effect<ReadonlyArray<McpServerConfig>, PoseidonRpcError>;
    readonly mcpRemove: (
      instanceId: ConnectorInstanceId,
      projectId: ProjectId | undefined,
      scope: McpServerScope,
      name: string,
    ) => Effect.Effect<ReadonlyArray<McpServerConfig>, PoseidonRpcError>;
  }
>()("server/rpc/ConnectorExtensions") {
  static readonly empty = Layer.succeed(
    ConnectorExtensions,
    ConnectorExtensions.of({
      skillsList: () => Effect.succeed([]),
      skillsAvailable: () => Effect.succeed([]),
      skillsLink: () => Effect.succeed([]),
      pluginsList: () => Effect.succeed([]),
      commandsList: () => Effect.succeed([]),
      mcpList: () => Effect.succeed([]),
      mcpAdd: () => Effect.succeed([]),
      mcpRemove: () => Effect.succeed([]),
    }),
  );
}

// ── Settings (real: backed by the `settings` table) ────────────

export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly get: Effect.Effect<Settings>;
    readonly update: (
      patch: SettingsPatch,
    ) => Effect.Effect<Settings, import("effect/unstable/sql/SqlError").SqlError>;
    /** Emits the current settings, then every update. */
    readonly changes: Stream.Stream<Settings>;
    /**
     * True when no `settings` row existed at boot. The connector manager reads
     * this to tell a first run, which it seeds, from a document with no
     * connectors left in it — a user who removed every connector must not see
     * them resurrected on the next boot.
     */
    readonly freshInstall: boolean;
    /**
     * True when the `settings` row at boot could not be decoded, so `get`
     * serves defaults in its place and the first `update` archives it. Nothing
     * should write at boot then: the row is left for a save the user makes.
     */
    readonly unreadable: boolean;
    /**
     * True when the `settings` row at boot is one a save wrote over an
     * undecodable row, which it archived. That save stored defaults plus its
     * own patch — no connectors, and no kinds offered — so the connector
     * manager reads it as a first run rather than as a user who removed
     * every connector.
     */
    readonly replacedUnreadable: boolean;
  }
>()("server/rpc/SettingsStore") {
  /**
   * Persists the whole settings document as one JSON row — the same table the
   * engine uses, so the app never has two sources of truth for preferences.
   *
   * `permissions` is the exception, and for the same reason: the rules live in
   * `permission_rules`, because the ladder filters them by scope on every tool
   * call and "allow always" appends a row from the approval flow. The document
   * projects that table on read and writes it back on update, so a rule the
   * user adds here is enforced and a rule the approval flow wrote shows up
   * here. The JSON copy is always stored empty so it can never disagree.
   *
   * The migrations are a layer input rather than something the entrypoint runs
   * first: this one reads its table while the graph is still being built, so
   * "the schema exists" has to be an edge in the graph or it is a race.
   */
  static readonly layer = Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reactivity = yield* Reactivity.Reactivity;
      const loaded = yield* loadSettingsRow(sql);
      const ref = yield* Ref.make<Settings>(loaded.settings);
      /**
       * The document's one change feed, replaying the current value so a late
       * subscriber starts from it.
       *
       * It is a hub of its own rather than a `SubscriptionRef`'s, because two
       * different things make this document change: a write through `update`,
       * and a rule appended straight to `permission_rules` by the approval
       * card's "allow always". The second leaves the stored row untouched, so
       * there is no new *value* to set — only the same document to re-read.
       * One feed both can publish to keeps `changes` a single subscription,
       * which is also what makes it impossible for a subscriber to be attached
       * to one source and miss the other.
       *
       * Sliding, and one deep. `settings.subscribe` hands this stream straight
       * to a WebSocket client, and an unbounded hub would let a stalled one
       * grow a queue of whole settings documents on the server — the same leak
       * the gateway and browser reactors carry a warning about. Dropping the
       * older element is lossless here: every element is the entire current
       * document, so the newest one says everything the ones behind it did.
       */
      const feed = yield* PubSub.sliding<Settings>({ capacity: 1, replay: 1 });
      yield* PubSub.publish(feed, loaded.settings);
      // Registered for the layer's lifetime — before any subscriber exists, so
      // no rule can be written into a gap where nothing is listening.
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          reactivity.registerUnsafe([PERMISSION_RULES_KEY], () => {
            PubSub.publishUnsafe(feed, Ref.getUnsafe(ref));
          }),
        ),
        (unregister) => Effect.sync(unregister),
      );
      /** The undecodable row, until the first write has archived it. */
      const unreadable = yield* Ref.make<string | null>(loaded.unreadable);
      /**
       * The document is written whole, so a read-modify-write that yields in
       * the middle loses the other writer's fields entirely — two windows
       * saving different pages at the same moment was enough. Serialised
       * behind one semaphore, like every other read-modify-write of a file.
       */
      const writeMutex = yield* Semaphore.make(1);

      /** The stored document with the live rules folded in. */
      const withRules = (settings: Settings) =>
        readRules(sql).pipe(
          Effect.map((permissions): Settings => ({ ...settings, permissions })),
          // `get` has no error channel, and a settings read must not fail over
          // the rules table — the last known list is better than nothing.
          Effect.catch(() => Effect.succeed(settings)),
        );

      return SettingsStore.of({
        get: Ref.get(ref).pipe(Effect.flatMap(withRules)),
        freshInstall: loaded.freshInstall,
        unreadable: loaded.unreadable !== null,
        replacedUnreadable: loaded.replacedUnreadable,
        update: (patch) =>
          writeMutex.withPermits(1)(
            Effect.gen(function* () {
              const archive = yield* Ref.get(unreadable);
              const current = yield* Ref.get(ref);
              const next: Settings = {
                ...current,
                ...Object.fromEntries(
                  Object.entries(patch).filter(([, value]) => value !== undefined),
                ),
              };
              const stored: Settings = { ...next, permissions: [] };
              // The rules table and the document are one edit. `writeRules`
              // replaces the whole table, so a failure between the two halves
              // would leave the user's rules gone and their preferences
              // unwritten — with nothing to tell them which half took.
              //
              // The archive is the same edit for the same reason: this write is
              // what destroys the undecodable row, so the copy has to become
              // durable exactly when the row that replaces it does.
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  if (archive !== null) {
                    yield* sql`
                      INSERT INTO settings (key, value_json, updated_at)
                      VALUES (
                        ${SETTINGS_UNREADABLE_ROW_KEY}, ${archive},
                        ${new Date().toISOString()}
                      )
                      ON CONFLICT (key) DO NOTHING
                    `;
                  }
                  if (patch.permissions !== undefined) {
                    yield* writeRules(sql, patch.permissions);
                  }
                  yield* sql`
                    INSERT INTO settings (key, value_json, updated_at)
                    VALUES (
                      ${SETTINGS_ROW_KEY}, ${JSON.stringify(stored)},
                      ${new Date().toISOString()}
                    )
                    ON CONFLICT (key) DO UPDATE
                      SET value_json = excluded.value_json, updated_at = excluded.updated_at
                  `;
                }),
              );
              // Only now: a rolled-back transaction has to leave the raw text
              // still in hand for the next attempt.
              yield* Ref.set(unreadable, null);
              yield* Ref.set(ref, stored);
              yield* PubSub.publish(feed, stored);
              return yield* withRules(stored);
            }),
          ),
        // `withRules` on the way out: what a subscriber is owed is the document
        // *plus* the rules as they are now, which is exactly what a rules-only
        // change republishes the unchanged stored value for.
        changes: Stream.fromPubSub(feed).pipe(Stream.mapEffect(withRules)),
      });
    }),
  ).pipe(Layer.provide(migrationsLayer));
}

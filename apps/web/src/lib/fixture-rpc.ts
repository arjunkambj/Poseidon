/**
 * What the fixture client answers over RPC: a `Proxy` shaped like the real
 * `PoseidonRpcClient` whose methods reply from inline data — the file search,
 * reads and existence check, the model and skill menus, the plugins, the keybinding
 * table, the staged attachments, the thread's checkpoints. Anything a fixture page has not taught it
 * dies loudly with the method's name, so a new read shows up the first time a
 * page touches it.
 *
 * The thread itself is not in here. `fixture-client.ts` owns the document,
 * folds the events its decider emits, and hands this module the stream and the
 * dispatch it answers `threads.subscribe` and `orchestration.dispatch` with.
 */

import type { PoseidonRpcClient } from "@poseidon/client-runtime/connection";
import type { ConnectorInstanceId, ProjectId } from "@poseidon/contracts/ids";
import type {
  CheckpointSummary,
  Command,
  CommandReceipt,
  ThreadStreamItem,
} from "@poseidon/contracts/orchestration";
import { PoseidonRpcError, PROTOCOL_VERSION } from "@poseidon/contracts/rpc";
import type {
  ConnectorDescriptor,
  ConnectorSummary,
  ModelOption,
  PluginSummary,
  SkillSummary,
} from "@poseidon/contracts/connectors";
import type { FileSearchResult } from "@poseidon/contracts/rpc";
import { defaultSettings } from "@poseidon/contracts/settings";
import type { Keybinding } from "@poseidon/contracts/settings";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { FIXTURE_ROOT, fixtureRead, fixtureStat } from "@/lib/fixture-files";
import { FIXTURE_IMAGES } from "@/lib/fixture-images";

// ── Inline fixture data ────────────────────────────────────────

export const FIXTURE_NOW = "2026-01-01T00:00:00.000Z";

const FIXTURE_FILES: ReadonlyArray<FileSearchResult> = [
  { path: "src/app.tsx", name: "app.tsx", isDirectory: false },
  { path: "src/components/composer.tsx", name: "composer.tsx", isDirectory: false },
  { path: "src/routes", name: "routes", isDirectory: true },
  { path: "docs/architecture.md", name: "architecture.md", isDirectory: false },
  { path: "packages/contracts/src/orchestration.ts", name: "orchestration.ts", isDirectory: false },
  { path: "package.json", name: "package.json", isDirectory: false },
];

const FIXTURE_MODELS: ReadonlyArray<ModelOption> = [
  {
    id: "fixture/flagship",
    label: "Flagship",
    family: "fixture",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    contextWindow: 200000,
  },
  {
    id: "fixture/mid",
    label: "Mid",
    family: "fixture",
    efforts: ["low", "medium", "high"],
    contextWindow: 200000,
  },
  {
    id: "fixture/small",
    label: "Small",
    family: "fixture",
    efforts: ["low", "medium"],
  },
];

const FIXTURE_SKILLS: ReadonlyArray<SkillSummary> = [
  {
    name: "commit",
    path: "skills/commit.md",
    description: "Write a commit message",
    enabled: true,
  },
  {
    name: "review",
    path: "skills/review.md",
    description: "Review the current diff",
    enabled: true,
  },
  {
    // A paragraph, like most real skill descriptions: the menus must still
    // show the name beside it.
    name: "migrate-database",
    path: "skills/migrate-database.md",
    description:
      "Plan and run a database schema migration end to end: read the current schema, write the forward and backward migration files, run them against a scratch copy, compare row counts before and after, and report anything that would lock a large table for longer than a few seconds.",
    enabled: true,
  },
  ...["changelog", "deps-audit", "docs-sync", "flaky-tests", "perf-profile", "release"].map(
    (name): SkillSummary => ({
      name,
      path: `skills/${name}.md`,
      description: `The ${name} skill`,
      enabled: true,
    }),
  ),
  {
    name: "bench",
    path: "skills/bench.md",
    description: "Run the benchmark suite",
    enabled: false,
  },
];

/** The first fixture connector's plugins; the second carries no plugins extension. */
const FIXTURE_PLUGINS: ReadonlyArray<PluginSummary> = [
  {
    name: "formatter",
    description: "Format files after every edit",
    source: "fixture-marketplace",
    scope: "user",
    enabled: true,
  },
  {
    name: "release-notes",
    description: "Draft release notes from merged changes",
    source: "fixture-marketplace",
    scope: "project",
    enabled: true,
  },
];

/** What the fixture build "ships": the one connector kind above, with a form. */
const FIXTURE_DESCRIPTOR: ConnectorDescriptor = {
  kind: "fixture",
  metadata: { displayName: "Fixture connector", iconKey: "terminal", accent: "#6b7280" },
  configFields: [
    {
      key: "binaryPath",
      label: "Binary path",
      description: "Path to the harness binary. Leave empty to use the discovered one.",
      control: "path",
      placeholder: "harness",
      optional: true,
    },
  ],
};

/** A 1x1 transparent PNG, for an attachment the fixture never really stored. */
const FIXTURE_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** What the fixture client lends its RPC answers: ids, the thread stream, the decider. */
export interface FixtureRpcContext {
  readonly serverInstanceId: string;
  readonly projectId: ProjectId;
  /** The instance the fixture thread is bound to; the second one gets fewer models. */
  readonly connectorInstanceId: ConnectorInstanceId;
  /** `threads.subscribe`: the current document, then every frame the fixture pushes. */
  readonly subscribe: () => Stream.Stream<ThreadStreamItem>;
  /** `orchestration.dispatch`: run the command through the fixture's decider. */
  readonly dispatch: (command: Command) => CommandReceipt;
  /** `connectors.list`, read fresh so a capability toggle shows. */
  readonly connectors: () => ReadonlyArray<ConnectorSummary>;
  /** `checkpoints.list`: every checkpoint the document records still exists. */
  readonly checkpoints: () => ReadonlyArray<CheckpointSummary>;
}

export const makeFixtureRpc = (context: FixtureRpcContext): PoseidonRpcClient => {
  /** What the page staged this session, keyed by the path it was given. */
  const fixtureAttachments = new Map<string, string>();
  // The user's overrides, as the server stores them: none, so every default.
  let keybindings: ReadonlyArray<Keybinding> = [];

  return new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) => {
      switch (key) {
        case "server.hello":
          return () =>
            Effect.succeed({
              protocolVersion: PROTOCOL_VERSION,
              serverInstanceId: context.serverInstanceId,
            });
        case "threads.subscribe":
          return () => context.subscribe();
        case "threads.listSubscribe":
          return () => Stream.never;
        case "orchestration.dispatch":
          return ({ command }: { command: Command }) =>
            Effect.sync(() => context.dispatch(command));
        case "checkpoints.list":
          return () => Effect.sync(() => context.checkpoints());
        case "files.search": {
          return ({ query }: { query: string }) =>
            Effect.succeed(
              FIXTURE_FILES.filter(
                (file) =>
                  query.trim().length === 0 ||
                  file.path.toLowerCase().includes(query.trim().toLowerCase()),
              ).slice(0, 20),
            );
        }
        case "files.read":
          return ({ path, offset, limit }: { path: string; offset?: number; limit?: number }) => {
            const content = fixtureRead(path, offset, limit);
            return content === null
              ? Effect.fail(new PoseidonRpcError({ code: "not-found", message: `no file ${path}` }))
              : Effect.succeed(content);
          };
        case "files.stat":
          return ({ paths }: { paths: ReadonlyArray<string> }) =>
            Effect.succeed(fixtureStat(paths));
        // Attachments in the fixture never leave the browser: staging echoes a
        // plausible reference, and reading one back answers what was staged,
        // the timeline fixture's own images, or the placeholder pixel, so the
        // composer's upload path and the timeline's thumbnails work with no
        // server.
        case "attachments.stage":
          return ({ threadId, name, base64 }: { threadId: string; name: string; base64: string }) =>
            Effect.sync(() => {
              const path = `/fixture/attachments/${threadId}/${name}`;
              fixtureAttachments.set(path, base64);
              return {
                path,
                name,
                mime: "image/png",
                size: Math.floor((base64.length * 3) / 4),
                sha256: "0".repeat(64),
              };
            });
        case "attachments.read":
          return ({ path }: { path: string }) =>
            Effect.sync(() => {
              const base64 =
                fixtureAttachments.get(path) ?? FIXTURE_IMAGES.get(path) ?? FIXTURE_PIXEL;
              return { mime: "image/png", size: Math.floor((base64.length * 3) / 4), base64 };
            });
        case "connectors.list":
          return () => Effect.sync(() => context.connectors());
        case "connectors.models":
          return ({ instanceId }: { instanceId: string }) =>
            Effect.succeed(
              instanceId === context.connectorInstanceId ? FIXTURE_MODELS : FIXTURE_MODELS.slice(1),
            );
        case "connectors.describe":
          return () => Effect.succeed([FIXTURE_DESCRIPTOR]);
        case "connectors.skills.list":
          return () => Effect.succeed(FIXTURE_SKILLS.filter((skill) => skill.enabled));
        case "connectors.plugins.list":
          return ({ instanceId }: { instanceId: string }) =>
            instanceId === context.connectorInstanceId
              ? Effect.succeed(FIXTURE_PLUGINS)
              : Effect.fail(
                  new PoseidonRpcError({
                    code: "unavailable",
                    message: `connector instance ${instanceId} does not manage plugins`,
                  }),
                );
        case "keybindings.get":
          return () => Effect.succeed(keybindings);
        case "keybindings.update":
          return ({ keybindings: next }: { keybindings: ReadonlyArray<Keybinding> }) =>
            Effect.sync(() => {
              keybindings = [...next];
              return keybindings;
            });
        case "settings.get":
          return () => Effect.succeed(defaultSettings());
        case "settings.subscribe":
          return () => Stream.succeed(defaultSettings());
        case "projects.list":
          return () =>
            Effect.succeed([
              {
                projectId: context.projectId,
                name: "fixture project",
                workspaceRoot: FIXTURE_ROOT,
                createdAt: FIXTURE_NOW,
                updatedAt: FIXTURE_NOW,
                threadCount: 1,
              },
            ]);
        // One editor beside the file manager and terminal, so the header's
        // "Open in" control and the file menus show; opening does nothing.
        case "editors.list":
          return () =>
            Effect.succeed([
              { id: "vscode", label: "VS Code", kind: "editor", supportsLine: true },
              { id: "finder", label: "Finder", kind: "file-manager", supportsLine: false },
              { id: "terminal", label: "Terminal", kind: "terminal", supportsLine: false },
            ]);
        case "editors.open":
          return () => Effect.succeed({});
        default:
          return () => Effect.die(new Error(`fixture: unimplemented rpc ${String(key)}`));
      }
    },
  });
};

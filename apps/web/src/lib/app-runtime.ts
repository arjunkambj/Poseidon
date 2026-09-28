/**
 * The settings-facing half of the renderer's atom runtime.
 *
 * `@/state/app-runtime` owns the one `makeRuntime` instance (and the offline
 * layer that keeps atoms mountable without a server). This module adds the
 * query/mutation atoms the settings pages need that the
 * shared client runtime does not carry, built once on top of that instance.
 * Atoms the shared runtime already publishes — `skillsAtom`,
 * `poseidonPluginsAtom`, `connectorModelsAtom`, `modelCatalogAtom`, `keybindingsAtom`,
 * `keybindingsUpdateAtom` — are
 * re-exported through the same bag rather than redefined here.
 */

import { Connection } from "@poseidon/client-runtime/connection";
import type { ConnectorInstanceId, ProjectId } from "@poseidon/contracts/ids";
import type { AgentSkill, McpServerConfig, McpServerScope } from "@poseidon/contracts/connectors";
import type { PluginId } from "@poseidon/contracts/plugins";
import type { SettingsPatch } from "@poseidon/contracts/settings";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import { isObject, isString } from "effect/Predicate";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Atom from "effect/unstable/reactivity/Atom";

import { instancesWith, totalCount, type ExtensionKind } from "@/lib/customize-instances";
import { getAppAtoms, type AppAtoms as BaseAppAtoms } from "@/state/app-runtime";

/** The message a failed `useAtomSet(..., { mode: "promiseExit" })` call should show. */
export const describeExitError = (exit: Exit.Exit<unknown, unknown>, fallback: string): string => {
  if (exit._tag !== "Failure") {
    return fallback;
  }
  const squashed = Cause.squash(exit.cause);
  return isObject(squashed) && "message" in squashed && isString(squashed.message)
    ? squashed.message
    : fallback;
};

/** A list's length once it has answered, `null` before. */
const lengthOf = (
  result: AsyncResult.AsyncResult<ReadonlyArray<unknown>, unknown>,
): number | null => (AsyncResult.isSuccess(result) ? result.value.length : null);

const makeSettingsAtoms = (base: BaseAppAtoms) => {
  const { runtime } = base;

  /** The live RPC client — reconnects resolve to the fresh one underneath. */
  const client = Effect.flatMap(Connection, (conn) => conn.client);

  const settingsUpdateAtom = runtime.fn((patch: SettingsPatch) =>
    Effect.flatMap(client, (c) => c["settings.update"]({ patch })),
  );

  /**
   * Turns one Poseidon plugin on or off for new sessions, then reloads the
   * list so the Plugins page and the composer's `@` menu show the change.
   */
  const pluginsSetEnabledAtom = runtime.fn((input: { pluginId: PluginId; enabled: boolean }, get) =>
    Effect.gen(function* () {
      const next = yield* Effect.flatMap(client, (c) => c["plugins.setEnabled"](input));
      get.registry.refresh(base.poseidonPluginsAtom);
      return next;
    }),
  );

  /** Creates the global plugins folder when it is missing and opens it in the file manager. */
  const pluginsOpenFolderAtom = runtime.fn(() =>
    Effect.flatMap(client, (c) => c["plugins.openFolder"]({})),
  );

  /**
   * The settings page's probe button: `refresh: true` re-runs every probe
   * server-side, then the list atom reloads so the page shows the outcome.
   */
  const probeConnectorsAtom = runtime.fn((_: void, get) =>
    Effect.gen(function* () {
      const list = yield* Effect.flatMap(client, (c) => c["connectors.list"]({ refresh: true }));
      get.registry.refresh(base.connectorsAtom);
      return list;
    }),
  );

  /**
   * MCP servers one connector instance manages, per project — `null` lists
   * user scope only. Only asked of an instance whose summary says it has the
   * extension; any other answers `unavailable`.
   */
  const mcpServersAtom = Atom.family((instanceId: ConnectorInstanceId) =>
    Atom.family((projectId: ProjectId | null) =>
      runtime.atom(
        Effect.flatMap(client, (c) =>
          c["connectors.mcp.list"]({
            instanceId,
            ...(projectId === null ? {} : { projectId }),
          }),
        ),
        { initialValue: [] as ReadonlyArray<McpServerConfig> },
      ),
    ),
  );

  const mcpUpsertAtom = runtime.fn(
    (
      input: {
        instanceId: ConnectorInstanceId;
        projectId: ProjectId | null;
        server: McpServerConfig;
      },
      get,
    ) =>
      Effect.gen(function* () {
        const next = yield* Effect.flatMap(client, (c) =>
          c["connectors.mcp.add"]({
            instanceId: input.instanceId,
            ...(input.projectId === null ? {} : { projectId: input.projectId }),
            server: input.server,
          }),
        );
        get.registry.refresh(mcpServersAtom(input.instanceId)(input.projectId));
        return next;
      }),
  );

  const mcpRemoveAtom = runtime.fn(
    (
      input: {
        instanceId: ConnectorInstanceId;
        projectId: ProjectId | null;
        scope: McpServerScope;
        name: string;
      },
      get,
    ) =>
      Effect.gen(function* () {
        const next = yield* Effect.flatMap(client, (c) =>
          c["connectors.mcp.remove"]({
            instanceId: input.instanceId,
            ...(input.projectId === null ? {} : { projectId: input.projectId }),
            scope: input.scope,
            name: input.name,
          }),
        );
        get.registry.refresh(mcpServersAtom(input.instanceId)(input.projectId));
        return next;
      }),
  );

  /** Skills in a shared folder one instance does not load yet. */
  const agentSkillsAtom = Atom.family((instanceId: ConnectorInstanceId) =>
    runtime.atom(
      Effect.flatMap(client, (c) => c["connectors.skills.available"]({ instanceId })),
      { initialValue: [] as ReadonlyArray<AgentSkill> },
    ),
  );

  /**
   * Links one shared-folder skill into the instance's user skills. `projectId`
   * is the scope on screen, whose skills list now includes it.
   */
  const skillsLinkAtom = runtime.fn(
    (input: { instanceId: ConnectorInstanceId; entry: string; projectId: ProjectId | null }, get) =>
      Effect.gen(function* () {
        const next = yield* Effect.flatMap(client, (c) =>
          c["connectors.skills.link"]({ instanceId: input.instanceId, entry: input.entry }),
        );
        get.registry.refresh(agentSkillsAtom(input.instanceId));
        get.registry.refresh(base.skillsAtom(input.instanceId)(input.projectId));
        return next;
      }),
  );

  /**
   * A Customize tab's count: its kind's list summed across every instance
   * that manages it, `null` until each has answered.
   */
  const customizeCountAtom = Atom.family((kind: ExtensionKind) =>
    Atom.family((projectId: ProjectId | null) =>
      Atom.make((get): number | null => {
        const connectors = get(base.connectorsAtom);
        if (!AsyncResult.isSuccess(connectors)) {
          return null;
        }
        return totalCount(
          instancesWith(connectors.value, kind).map(({ connectorInstanceId: id }) =>
            kind === "skills"
              ? lengthOf(get(base.skillsAtom(id)(projectId)))
              : lengthOf(get(mcpServersAtom(id)(projectId))),
          ),
        );
      }),
    ),
  );

  /**
   * The Plugins tab's count: Poseidon's plugins plus every instance's own,
   * `null` until each has answered.
   */
  const pluginsCountAtom = Atom.family((projectId: ProjectId | null) =>
    Atom.make((get): number | null => {
      const connectors = get(base.connectorsAtom);
      if (!AsyncResult.isSuccess(connectors)) {
        return null;
      }
      const poseidon = get(base.poseidonPluginsAtom);
      return totalCount([
        AsyncResult.isSuccess(poseidon) ? poseidon.value.plugins.length : null,
        ...instancesWith(connectors.value, "plugins").map(({ connectorInstanceId: id }) =>
          lengthOf(get(base.pluginsAtom(id)(projectId))),
        ),
      ]);
    }),
  );

  /**
   * Settings → Import's list of harness sessions. Not kept alive: it reads up
   * to every instance's session files, so it loads while the page is open and
   * again each time it opens, never in the background.
   */
  const importableSessionsAtom = runtime.atom(
    Effect.flatMap(client, (c) => c["sessions.importable"]({})),
  );

  /**
   * Imports one session as a thread. The thread arrives through the thread
   * list subscription, but projects have none, so the list reloads here: an
   * import into a folder with no project yet adds one. Concurrent, so a
   * Retry does not cut off a run's import in flight, and kept alive, so an
   * import that has started finishes even when the page closes.
   */
  const importSessionAtom = Atom.keepAlive(
    runtime.fn(
      (input: { connectorInstanceId: ConnectorInstanceId; sourceId: string }, get) =>
        Effect.gen(function* () {
          const result = yield* Effect.flatMap(client, (c) => c["sessions.import"](input));
          get.registry.refresh(base.projectsAtom);
          return result;
        }),
      { concurrent: true },
    ),
  );

  return {
    ...base,
    settingsUpdateAtom,
    pluginsSetEnabledAtom,
    pluginsOpenFolderAtom,
    probeConnectorsAtom,
    mcpServersAtom,
    mcpUpsertAtom,
    mcpRemoveAtom,
    agentSkillsAtom,
    skillsLinkAtom,
    customizeCountAtom,
    pluginsCountAtom,
    importableSessionsAtom,
    importSessionAtom,
  };
};

export type AppAtoms = ReturnType<typeof makeSettingsAtoms>;

let appAtoms: AppAtoms | null = null;

/**
 * The bootstrapped atoms. `installAppAtoms` runs in `main.tsx` before the
 * router mounts, so by the time a component calls this the base bag exists.
 */
export const useAppAtoms = (): AppAtoms => {
  appAtoms ??= makeSettingsAtoms(getAppAtoms());
  return appAtoms;
};

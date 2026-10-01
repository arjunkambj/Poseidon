/**
 * Brings an install's connectors list up to what this build ships.
 *
 * The registry's order is the harness rank (`boot.ts`): the kind a thread that
 * chose no instance runs on comes first, and a fresh install is seeded in that
 * order. An existing install is not re-seeded, so on its own it would never
 * see a kind added after it was set up, nor a change of rank: an install from
 * when Command Code came first kept routing every new thread to it. The
 * connector manager runs this over the document once per boot instead, and
 * writes what it returns as one update.
 *
 * - Offering. Every shipped kind `offeredConnectorKinds` does not list gets
 *   one enabled instance, named and configured as a fresh seed would name and
 *   configure it, unless the document holds one of that kind already. Either
 *   way the kind is listed from then on, so an instance the user removes
 *   stays removed. A document from before the list existed cannot tell a
 *   kind it never had from one the user removed, so it is offered every kind
 *   it lacks, once — except one with no connectors at all, which only a user
 *   who removed every one of them can have written.
 * - Ranking (`RANK_MIGRATION`). The list is sorted once into the registry's
 *   rank, with any kind this build does not ship after the rest in its
 *   current order. Once, so a reorder the user makes later is theirs.
 * - The app-wide default model (`DEFAULT_MODEL_MIGRATION`). Settled here
 *   only when there is none; otherwise it waits for model lists, see
 *   `defaultModelVerdict`.
 */

import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import type {
  ConnectorInstanceConfig,
  Settings,
  SettingsPatch,
} from "@poseidon/contracts/settings";
import type { AnyConnectorDefinition } from "@poseidon/connector-sdk/definition";

/** @public The one-time sort into the registry's rank. */
export const RANK_MIGRATION = "harness-rank";

/** @public The one-time check of the app-wide default model against the rank. */
export const DEFAULT_MODEL_MIGRATION = "harness-rank-default-model";

/** What the upgrade needs of a shipped definition, in rank order. */
type Shipped = Pick<AnyConnectorDefinition, "kind" | "metadata" | "defaultConfig">;

/** The list sorted into the registry's rank; an unshipped kind keeps its place behind them. */
const byRank = (
  connectors: ReadonlyArray<ConnectorInstanceConfig>,
  shipped: ReadonlyArray<Shipped>,
): ReadonlyArray<ConnectorInstanceConfig> => {
  const rank = (kind: string) => {
    const index = shipped.findIndex((definition) => definition.kind === kind);
    return index === -1 ? shipped.length : index;
  };
  // `toSorted` is stable, so entries of one kind keep their relative order.
  return connectors.toSorted((a, b) => rank(a.kind) - rank(b.kind));
};

/**
 * The patch that brings `settings` up to `shipped`, or null when it is there
 * already. `freshInstall` is whether no settings row existed at boot, or one
 * that could not be decoded was archived by a save, this boot or an earlier
 * one. It is read only while no kind has been offered, when the document then
 * holds only what that save wrote.
 */
export const upgradeConnectors = (
  settings: Settings,
  shipped: ReadonlyArray<Shipped>,
  freshInstall: boolean,
  newInstanceId: () => ConnectorInstanceId,
): SettingsPatch | null => {
  const offered = new Set(settings.offeredConnectorKinds);
  const unoffered = shipped.filter((definition) => !offered.has(definition.kind));
  const removedEverything =
    !freshInstall &&
    settings.connectors.length === 0 &&
    settings.offeredConnectorKinds.length === 0;
  const added = removedEverything
    ? []
    : unoffered
        .filter((definition) => !settings.connectors.some((conn) => conn.kind === definition.kind))
        .map((definition): ConnectorInstanceConfig => ({
          connectorInstanceId: newInstanceId(),
          kind: definition.kind,
          displayName: definition.metadata.displayName,
          enabled: true,
          config: definition.defaultConfig(),
        }));
  const migrations = [...settings.connectorMigrations];
  let connectors = [...settings.connectors, ...added];
  if (!migrations.includes(RANK_MIGRATION)) {
    connectors = [...byRank(connectors, shipped)];
    migrations.push(RANK_MIGRATION);
  }
  if (!migrations.includes(DEFAULT_MODEL_MIGRATION) && settings.defaults.model === null) {
    migrations.push(DEFAULT_MODEL_MIGRATION);
  }
  if (unoffered.length === 0 && migrations.length === settings.connectorMigrations.length) {
    return null;
  }
  return {
    connectors,
    offeredConnectorKinds: [
      ...settings.offeredConnectorKinds,
      ...unoffered.map((definition) => definition.kind),
    ],
    connectorMigrations: migrations,
  };
};

/**
 * The kinds whose models the default-model check asks: every shipped kind
 * ranked ahead of the last one.
 *
 * The rank puts last the harness the app defaulted to before it existed, and
 * the one the default should never fall to while another can run. A saved
 * default model the harnesses ahead of it do not run is that harness's model,
 * and the default model outranks routing (`seedModel`, and New task's pick
 * in the renderer), so it would keep every new thread there.
 */
export const rankedAheadOfLast = (shipped: ReadonlyArray<Shipped>): ReadonlyArray<string> =>
  shipped.slice(0, -1).map((definition) => definition.kind);

/** One enabled instance's model list, and whether its probe says it can run. */
export interface DefaultModelAnswer {
  readonly models: ReadonlyArray<string>;
  readonly canRun: boolean;
}

/**
 * What to do with a saved default model, from the model lists of the enabled
 * instances ranked ahead of the last harness (`ahead`) and of the last one's
 * (`last`):
 *
 * - `keep` when one ahead lists it: the user chose a harness that ranks ahead
 *   anyway. Also when the last harness answered and does not list it — the
 *   model is not the one this check exists to take new threads off, and an
 *   ahead harness that was slow to answer may well run it.
 * - `clear` once the model is known to be the last harness's — it lists it,
 *   or it said nothing and every instance ahead answered without it — and
 *   one ahead that can run has answered: new threads then start where
 *   routing sends them.
 * - `undecided` otherwise, so a later boot asks again. That covers an ahead
 *   harness that can run but listed nothing (a probe that timed out, a
 *   handshake that failed): with the last one silent as well, the model may
 *   be that harness's, and clearing it would lose the user's choice for good.
 *   It also covers none ahead that can run having answered — not installed,
 *   signed out or still probing — so a default whose replacement cannot run
 *   yet is not cleared.
 *
 * An instance that is disabled or removed gives no answer at all, so a model
 * only it listed reads as the last harness's once every other one has
 * answered without it.
 */
export const defaultModelVerdict = (
  model: string,
  ahead: ReadonlyArray<DefaultModelAnswer>,
  last: ReadonlyArray<DefaultModelAnswer>,
): "keep" | "clear" | "undecided" => {
  if (ahead.some((answer) => answer.models.includes(model))) {
    return "keep";
  }
  const lastAnswered = last.some((answer) => answer.models.length > 0);
  if (lastAnswered && !last.some((answer) => answer.models.includes(model))) {
    return "keep";
  }
  const lastsModel = lastAnswered || ahead.every((answer) => answer.models.length > 0);
  return lastsModel && ahead.some((answer) => answer.canRun && answer.models.length > 0)
    ? "clear"
    : "undecided";
};

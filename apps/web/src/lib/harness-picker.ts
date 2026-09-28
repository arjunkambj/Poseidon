/**
 * The harness-circle model picker's data and keyboard model, with no React so
 * the component tests (static markup, no DOM) can leave every key path to the
 * unit tests here.
 *
 * The picker has two levels. The rail is a column of round harness avatars,
 * one per section of `modelPickerGroups`; the flyout beside it lists the
 * highlighted harness's models. Typing a query swaps both for one flat list of
 * matches across every harness the rail shows.
 *
 * DOM focus stays in the search input the whole time: the component feeds its
 * keys through `pickerReduce` and points `aria-activedescendant` at whatever
 * the state highlights, so no focus moves between avatars and rows.
 *
 * Moves stop at either end rather than wrapping, the way the effort keys do
 * (`stepEffort`), so holding a key never jumps from the last row to the first.
 */

import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ConnectorSummary } from "@poseidon/contracts/connectors";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { EFFORT_ORDER, type Effort } from "@poseidon/contracts/enums";

import { providerKey, spansProviders } from "@/components/ui/icons/brand-icons";
import { orderEfforts } from "@/lib/efforts";
import { catalogMonograms, harnessMonograms } from "@/lib/harness-monogram";
import { decodeModelPick, type ModelPick, type ModelPickerGroup } from "@/lib/model-picks";

export interface HarnessRailItem {
  /** The encoded pick, unique across the whole rail (`encodeModelPick`). */
  readonly value: string;
  readonly pick: ModelPick;
  readonly label: string;
  /** The model's family. */
  readonly family: string;
  /** The connector's one-line tagline for the model, when it gives one. */
  readonly description?: string;
  /** The effort ladder in a few characters ("low–high"); absent without rungs. */
  readonly efforts?: string;
  /**
   * The model's `providerKey`, set only when its harness's models span
   * providers (`spansProviders`), so the row leads with the provider's mark.
   */
  readonly provider?: string;
  readonly disabled: boolean;
  /** The pick the thread (or new task) is on. */
  readonly current: boolean;
}

export interface HarnessRailEntry {
  readonly connector: ConnectorSummary;
  readonly instanceId: ConnectorInstanceId;
  readonly label: string;
  readonly monogram: string;
  /** The connector's `metadata.iconKey`, which picks its logo; absent until the descriptors load. */
  readonly iconKey?: string;
  /** Another instance than the thread's, on a thread that can no longer switch. */
  readonly locked: boolean;
  /** The harness the current pick is under. */
  readonly current: boolean;
  /**
   * The instance lists models at all; false when its models call came back
   * empty or failed. With no `items`, this tells "every model switched off"
   * from "none to switch".
   */
  readonly listsModels: boolean;
  readonly items: ReadonlyArray<HarnessRailItem>;
}

/**
 * A ladder in a few characters: one rung by name, a run of adjacent rungs as
 * its ends ("low–high"), and a ladder with gaps as its rung count.
 */
export const effortSummary = (efforts: ReadonlyArray<Effort> | undefined): string | undefined => {
  if (efforts === undefined) {
    return undefined;
  }
  const ladder = orderEfforts(efforts);
  const first = ladder[0];
  const last = ladder.at(-1);
  if (first === undefined || last === undefined) {
    return undefined;
  }
  if (ladder.length === 1) {
    return first;
  }
  const adjacent = EFFORT_ORDER.indexOf(last) - EFFORT_ORDER.indexOf(first) === ladder.length - 1;
  return adjacent ? `${first}–${last}` : `${ladder.length} levels`;
};

/**
 * One rail entry per picker section, in order, each with its models. The
 * sections are what the picker lists; `catalog` is the whole, unfiltered
 * catalog, so a harness's monogram is the same on every surface whatever is
 * switched off (`catalogMonograms`). `iconKeys` maps a connector kind to its
 * `metadata.iconKey` (`useConnectorIconKeys`), so the avatar can draw the
 * harness's logo; a kind missing from it keeps the monogram. A model's
 * provider is read from its id and its family in the catalog, never its label,
 * and only a harness whose catalog spans providers marks its models.
 */
export const harnessRail = (
  groups: ReadonlyArray<ModelPickerGroup>,
  current: ModelPick | null,
  catalog: ReadonlyArray<ConnectorModels>,
  iconKeys: ReadonlyMap<string, string> = new Map(),
): ReadonlyArray<HarnessRailEntry> => {
  const monograms = catalogMonograms(catalog);
  return groups.map((group) => {
    const instanceId = group.connector.connectorInstanceId;
    const isCurrent = current !== null && current.connectorInstanceId === instanceId;
    const listed = catalog.find((entry) => entry.connector.connectorInstanceId === instanceId);
    const iconKey = iconKeys.get(group.connector.kind);
    const families = new Map(listed?.models.map((model) => [model.id, model.family]));
    const marked = listed !== undefined && spansProviders(listed.models);
    return {
      connector: group.connector,
      instanceId,
      label: group.connector.displayName,
      monogram:
        monograms.get(instanceId) ?? harnessMonograms([group.connector.displayName])[0] ?? "",
      ...(iconKey === undefined ? {} : { iconKey }),
      locked: group.locked,
      current: isCurrent,
      listsModels: (listed?.models.length ?? group.items.length) > 0,
      items: group.items.flatMap((item) => {
        const pick = decodeModelPick(item.value);
        if (pick === null) {
          return [];
        }
        const efforts = effortSummary(item.efforts);
        const provider = marked
          ? providerKey(pick.model, families.get(pick.model) ?? "")
          : undefined;
        return [
          {
            value: item.value,
            pick,
            label: item.label,
            family: item.family,
            ...(item.description === undefined ? {} : { description: item.description }),
            ...(efforts === undefined ? {} : { efforts }),
            ...(provider === undefined ? {} : { provider }),
            disabled: item.disabled,
            current: isCurrent && current.model === pick.model,
          },
        ];
      }),
    };
  });
};

export interface SearchResult {
  readonly harnessIndex: number;
  readonly modelIndex: number;
  readonly item: HarnessRailItem;
}

/** Whether `query` starts `text` or one of its words (after a non-alphanumeric). */
const startsWord = (text: string, query: string): boolean => {
  for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + 1)) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1] ?? "")) {
      return true;
    }
  }
  return false;
};

/**
 * How well a model matches, best first: its label or id starts with the query
 * (0), a word in either does (1), its family, tagline or harness name does at
 * a word (2), or the query is anywhere in any of them (3). `null` is no match.
 */
const matchRank = (entry: HarnessRailEntry, item: HarnessRailItem, query: string) => {
  const own = [item.label, item.pick.model].map((text) => text.toLocaleLowerCase());
  const context = [item.family, item.description ?? "", entry.label].map((text) =>
    text.toLocaleLowerCase(),
  );
  if (own.some((text) => text.startsWith(query))) {
    return 0;
  }
  if (own.some((text) => startsWord(text, query))) {
    return 1;
  }
  if (context.some((text) => startsWord(text, query))) {
    return 2;
  }
  return [...own, ...context].some((text) => text.includes(query)) ? 3 : null;
};

/**
 * Every model on the rail that matches the trimmed query, case-insensitively,
 * on its label, id, family, tagline or harness name: prefix matches first, then rail
 * order. An empty query matches nothing — the rail is showing instead.
 */
export const searchModels = (
  rail: ReadonlyArray<HarnessRailEntry>,
  query: string,
): ReadonlyArray<SearchResult> => {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) {
    return [];
  }
  const ranked = rail.flatMap((entry, harnessIndex) =>
    entry.items.flatMap((item, modelIndex) => {
      const rank = matchRank(entry, item, needle);
      return rank === null ? [] : [{ rank, result: { harnessIndex, modelIndex, item } }];
    }),
  );
  // `sort` is stable, so equal ranks keep rail order.
  return ranked.sort((left, right) => left.rank - right.rank).map(({ result }) => result);
};

export type PickerZone = "rail" | "models";

export interface PickerState {
  /** The search input's text, untrimmed. */
  readonly query: string;
  readonly zone: PickerZone;
  /** The highlighted rail entry, whose flyout is open. */
  readonly harness: number;
  /** The highlighted row of that flyout. */
  readonly model: number;
  /** The highlighted search result, while there is a query. */
  readonly result: number;
}

export type PickerKey =
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "Enter"
  | "Escape";

export type PickerEvent =
  | { readonly type: PickerKey }
  | { readonly type: "hoverHarness"; readonly index: number }
  /** A flyout row, or a search result while there is a query. */
  | { readonly type: "hoverModel"; readonly index: number }
  | { readonly type: "setQuery"; readonly text: string };

export type PickerEffect =
  /** Choose this model; the picker closes. */
  | { readonly type: "pick"; readonly pick: ModelPick }
  /** Tick or untick this model (compare mode); the picker stays open. */
  | { readonly type: "toggle"; readonly pick: ModelPick }
  | { readonly type: "close" }
  /** The query was cleared; the input should show it. */
  | { readonly type: "clearQuery" };

export interface PickerStep {
  readonly state: PickerState;
  readonly effect?: PickerEffect;
  /** The event meant something here, so the key's default action should not run. */
  readonly handled: boolean;
}

export interface PickerOptions {
  /** Compare mode: Enter ticks a model instead of choosing it. */
  readonly multi?: boolean;
}

const PICKER_KEYS: ReadonlySet<string> = new Set<PickerKey>([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Enter",
  "Escape",
]);

/** The event a `KeyboardEvent.key` stands for, or `null` for a key the picker leaves alone. */
export const pickerKey = (key: string): PickerEvent | null =>
  PICKER_KEYS.has(key) ? { type: key as PickerKey } : null;

const clamp = (index: number, length: number) => Math.max(0, Math.min(index, length - 1));

/** Where a harness's flyout opens: on the current model if it lists it, else the top. */
const flyoutStart = (entry: HarnessRailEntry | undefined): number =>
  Math.max(0, entry?.items.findIndex((item) => item.current) ?? 0);

/** The picker as it opens: on the current harness, with its flyout on the current model. */
export const initialPickerState = (
  rail: ReadonlyArray<HarnessRailEntry>,
  current: ModelPick | null,
): PickerState => {
  const closed = { query: "", result: 0 };
  const own =
    current === null
      ? -1
      : rail.findIndex((entry) => entry.instanceId === current.connectorInstanceId);
  const ownEntry = rail[own];
  if (ownEntry !== undefined && current !== null) {
    const model = Math.max(
      0,
      ownEntry.items.findIndex((item) => item.pick.model === current.model),
    );
    return { ...closed, zone: ownEntry.items.length > 0 ? "models" : "rail", harness: own, model };
  }
  // No current harness on the rail: highlight the first one a pick can come from.
  const harness = Math.max(
    0,
    rail.findIndex((entry) => !entry.locked),
  );
  return { ...closed, zone: "rail", harness, model: flyoutStart(rail[harness]) };
};

const unhandled = (state: PickerState): PickerStep => ({ state, handled: false });
const moved = (state: PickerState): PickerStep => ({ state, handled: true });

/** Enter on an item: pick or tick it, unless it cannot be picked. */
const choose = (
  state: PickerState,
  entry: HarnessRailEntry | undefined,
  item: HarnessRailItem | undefined,
  options: PickerOptions,
): PickerStep => {
  if (entry === undefined || item === undefined || entry.locked || item.disabled) {
    return moved(state);
  }
  return {
    state,
    handled: true,
    effect: { type: options.multi === true ? "toggle" : "pick", pick: item.pick },
  };
};

/** Keys while a query shows the flat result list. */
const searchReduce = (
  state: PickerState,
  key: PickerKey,
  rail: ReadonlyArray<HarnessRailEntry>,
  options: PickerOptions,
): PickerStep => {
  const results = searchModels(rail, state.query);
  switch (key) {
    case "ArrowUp":
    case "ArrowDown": {
      if (results.length === 0) {
        return moved(state);
      }
      const result = clamp(state.result + (key === "ArrowUp" ? -1 : 1), results.length);
      return moved({ ...state, result });
    }
    case "Enter": {
      const hit = results[state.result];
      return choose(
        state,
        hit === undefined ? undefined : rail[hit.harnessIndex],
        hit?.item,
        options,
      );
    }
    case "Escape":
      return {
        state: { ...state, query: "", result: 0 },
        effect: { type: "clearQuery" },
        handled: true,
      };
    // Left, Right, Home and End edit the query's text.
    default:
      return unhandled(state);
  }
};

/** Keys on the rail of harness avatars. */
const railReduce = (
  state: PickerState,
  key: PickerKey,
  rail: ReadonlyArray<HarnessRailEntry>,
): PickerStep => {
  const go = (harness: number): PickerStep =>
    rail.length === 0 || harness === state.harness
      ? moved(state)
      : moved({ ...state, harness, model: flyoutStart(rail[harness]) });
  switch (key) {
    case "ArrowUp":
      return go(clamp(state.harness - 1, rail.length));
    case "ArrowDown":
      return go(clamp(state.harness + 1, rail.length));
    case "Home":
      return go(0);
    case "End":
      return go(rail.length - 1);
    case "ArrowRight":
    case "Enter": {
      const entry = rail[state.harness];
      // A locked harness's flyout only says what exists; it has nothing to enter.
      if (entry === undefined || entry.locked || entry.items.length === 0) {
        return moved(state);
      }
      return moved({ ...state, zone: "models", model: flyoutStart(entry) });
    }
    case "ArrowLeft":
      return moved(state);
    case "Escape":
      return { state, effect: { type: "close" }, handled: true };
  }
};

/** Keys inside a harness's flyout. */
const modelsReduce = (
  state: PickerState,
  key: PickerKey,
  rail: ReadonlyArray<HarnessRailEntry>,
  options: PickerOptions,
): PickerStep => {
  const entry = rail[state.harness];
  const count = entry?.items.length ?? 0;
  const go = (model: number): PickerStep =>
    count === 0 ? moved(state) : moved({ ...state, model: clamp(model, count) });
  switch (key) {
    case "ArrowUp":
      return go(state.model - 1);
    case "ArrowDown":
      return go(state.model + 1);
    case "Home":
      return go(0);
    case "End":
      return go(count - 1);
    case "ArrowLeft":
    case "Escape":
      return moved({ ...state, zone: "rail" });
    case "ArrowRight":
      return moved(state);
    case "Enter":
      return choose(state, entry, entry?.items[state.model], options);
  }
};

/**
 * One step of the picker. With a query the keys drive the flat result list;
 * without one they drive the rail and its flyout. Escape peels one layer: the
 * query, then the flyout, then the picker.
 */
export const pickerReduce = (
  state: PickerState,
  event: PickerEvent,
  rail: ReadonlyArray<HarnessRailEntry>,
  options: PickerOptions = {},
): PickerStep => {
  switch (event.type) {
    case "setQuery":
      return moved({ ...state, query: event.text, result: 0 });
    case "hoverHarness": {
      if (rail[event.index] === undefined) {
        return unhandled(state);
      }
      const model = event.index === state.harness ? state.model : flyoutStart(rail[event.index]);
      return moved({ ...state, zone: "rail", harness: event.index, model });
    }
    case "hoverModel": {
      if (state.query.trim().length > 0) {
        const results = searchModels(rail, state.query);
        return results[event.index] === undefined
          ? unhandled(state)
          : moved({ ...state, result: event.index });
      }
      return rail[state.harness]?.items[event.index] === undefined
        ? unhandled(state)
        : moved({ ...state, zone: "models", model: event.index });
    }
  }
  if (state.query.trim().length > 0) {
    return searchReduce(state, event.type, rail, options);
  }
  // A query of spaces searches for nothing, but Escape still clears it first.
  if (event.type === "Escape" && state.query.length > 0) {
    return {
      state: { ...state, query: "", result: 0 },
      effect: { type: "clearQuery" },
      handled: true,
    };
  }
  return state.zone === "rail"
    ? railReduce(state, event.type, rail)
    : modelsReduce(state, event.type, rail, options);
};

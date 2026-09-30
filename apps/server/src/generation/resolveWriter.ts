/**
 * Which harness, model and effort write a piece of generated text.
 *
 * The Models page's Writing model is tried first, and only while it is still
 * usable: its instance is open, its harness and model are switched on (the
 * pickers' rule, below) and the instance can generate text. A chosen model
 * that fails any of that falls back to Same as the thread and says so once,
 * in `notice`. Same as the thread is the thread's own instance and model; with
 * no thread — a pull request opened from the dock — it is the routed default,
 * the first open enabled connector with the model a new thread would be
 * seeded with. When none of those can generate text the answer is
 * `unavailable`, and the caller keeps whatever it had.
 *
 * The switch rule mirrors the web's `lib/model-visibility.ts` on purpose
 * rather than importing it: every harness is on and every model is on unless
 * its connector marks it `hidden`, and a stored switch overrides either.
 */

import type { ConnectorInstance } from "@poseidon/connector-sdk/definition";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { Effort } from "@poseidon/contracts/enums";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import type { ThreadSession, ThreadSettings } from "@poseidon/contracts/orchestration";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import type { ModelPickerSettings, Settings } from "@poseidon/contracts/settings";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { routingPreference, seedModel, type Unrunnable } from "../settings/connectorRouting";

/** Said once when the chosen Writing model could not be used. */
export const WRITER_FALLBACK_NOTICE =
  "Your writing model is off or gone — used the thread's model.";

/** Why nothing was written: no open harness can write text. */
export const NO_WRITER_MESSAGE =
  "No harness that can write text is available — check Settings → Connectors.";

/** An instance that can write text, narrowed so the call site needs no check. */
export type WritingInstance = ConnectorInstance & Required<Pick<ConnectorInstance, "generateText">>;

/** Who writes: the instance, the model on it, the effort when the model takes it. */
export interface Writer {
  readonly instance: WritingInstance;
  readonly model: string;
  readonly effort?: Effort;
  readonly notice?: string;
}

/** A harness and model, as a thread or the settings name them. */
export interface WriterPick {
  readonly connectorInstanceId: ConnectorInstanceId;
  readonly model: string;
}

/** What the resolver needs from the running server; tests pass their own. */
export interface WriterDeps {
  /** The open instance with this id, or null when none is open. */
  readonly instance: (instanceId: ConnectorInstanceId) => Effect.Effect<ConnectorInstance | null>;
  /** What the instance says it runs; empty when it cannot tell. */
  readonly models: (instanceId: ConnectorInstanceId) => Effect.Effect<ReadonlyArray<ModelOption>>;
  /** Where a new thread would run, and on what model; null when nowhere. */
  readonly routed: Effect.Effect<WriterPick | null>;
}

/** The thread fields "Same as the thread" reads. */
export type WriterThread = {
  readonly settings: Pick<ThreadSettings, "model" | "connectorInstanceId">;
  readonly session: Pick<ThreadSession, "connectorInstanceId"> | null;
};

// ── The switches ───────────────────────────────────────────────

/** A stored switch, read as an own key so an id like `constructor` is not a hit. */
const stored = (
  record: Readonly<Record<string, boolean>> | undefined,
  key: string,
): boolean | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

const harnessSwitchedOn = (prefs: ModelPickerSettings, instanceId: string): boolean =>
  stored(prefs.harnesses, instanceId) ?? true;

const modelSwitchedOn = (
  prefs: ModelPickerSettings,
  instanceId: string,
  model: ModelOption,
): boolean => {
  const models = Object.hasOwn(prefs.models, instanceId) ? prefs.models[instanceId] : undefined;
  return stored(models, model.id) ?? model.hidden !== true;
};

// ── Resolving ──────────────────────────────────────────────────

const canWrite = (instance: ConnectorInstance | null): instance is WritingInstance =>
  instance !== null &&
  instance.generateText !== undefined &&
  instance.capabilities.textGeneration !== false;

/** `effort` when the model lists it, so a model that takes none is sent none. */
const effortFor = (
  models: ReadonlyArray<ModelOption>,
  model: string,
  effort: Effort,
): Effort | undefined =>
  models.find((option) => option.id === model)?.efforts.includes(effort) === true
    ? effort
    : undefined;

const writerFor = (
  deps: WriterDeps,
  pick: WriterPick,
  effort: Effort,
): Effect.Effect<Writer | null> =>
  Effect.gen(function* () {
    const instance = yield* deps.instance(pick.connectorInstanceId);
    if (!canWrite(instance)) {
      return null;
    }
    const chosenEffort = effortFor(
      yield* deps.models(pick.connectorInstanceId),
      pick.model,
      effort,
    );
    return {
      instance,
      model: pick.model,
      ...(chosenEffort === undefined ? {} : { effort: chosenEffort }),
    };
  });

/** The chosen Writing model, when it is still open, switched on and able to write. */
const chosenWriter = (
  deps: WriterDeps,
  settings: Pick<Settings, "generation" | "modelPicker">,
): Effect.Effect<Writer | null> =>
  Effect.gen(function* () {
    const chosen = settings.generation.writingModel;
    if (chosen === null || !harnessSwitchedOn(settings.modelPicker, chosen.connectorInstanceId)) {
      return null;
    }
    const option = (yield* deps.models(chosen.connectorInstanceId)).find(
      (model) => model.id === chosen.model,
    );
    if (
      option === undefined ||
      !modelSwitchedOn(settings.modelPicker, chosen.connectorInstanceId, option)
    ) {
      return null;
    }
    return yield* writerFor(deps, chosen, settings.generation.writingEffort);
  });

/** Same as the thread: its own instance and model, then the routed default. */
const sameAsThread = (
  deps: WriterDeps,
  thread: WriterThread | null,
  effort: Effort,
): Effect.Effect<Writer | null> =>
  Effect.gen(function* () {
    const routed = yield* deps.routed;
    const instanceId =
      thread === null
        ? undefined
        : (thread.settings.connectorInstanceId ??
          thread.session?.connectorInstanceId ??
          routed?.connectorInstanceId);
    const own: WriterPick | null =
      thread === null || instanceId === undefined
        ? null
        : { connectorInstanceId: instanceId, model: thread.settings.model };
    for (const pick of [own, routed]) {
      if (pick === null) continue;
      const writer = yield* writerFor(deps, pick, effort);
      if (writer !== null) return writer;
    }
    return null;
  });

/**
 * The writer for one piece of text, or `unavailable` when no open harness can
 * write it.
 */
export const resolveWriter = (
  settings: Pick<Settings, "generation" | "modelPicker">,
  thread: WriterThread | null,
  deps: WriterDeps,
): Effect.Effect<Writer, PoseidonRpcError> =>
  Effect.gen(function* () {
    const effort = settings.generation.writingEffort;
    const chosen = yield* chosenWriter(deps, settings);
    if (chosen !== null) {
      return chosen;
    }
    const fallback = yield* sameAsThread(deps, thread, effort);
    if (fallback === null) {
      return yield* Effect.fail(
        new PoseidonRpcError({ code: "unavailable", message: NO_WRITER_MESSAGE }),
      );
    }
    return settings.generation.writingModel === null
      ? fallback
      : { ...fallback, notice: WRITER_FALLBACK_NOTICE };
  });

/**
 * Where a new thread would run and on what model: the instance and model the
 * engine would seed it with (`seedModel`), which is the first instance in the
 * routing order (`routingPreference`) the registry holds open unless the
 * app-wide default model is another open instance's. Null when neither can be
 * told.
 */
export const routedPick = (
  sql: SqlClient.SqlClient,
  open: Effect.Effect<ReadonlyArray<ConnectorInstanceId>>,
  modelIds: (instanceId: ConnectorInstanceId) => Effect.Effect<ReadonlyArray<string>>,
  unrunnable: Unrunnable = null,
): Effect.Effect<WriterPick | null> =>
  Effect.gen(function* () {
    const preferred = yield* routingPreference(sql, unrunnable);
    const openIds = yield* open;
    const instanceId = preferred.find((id) => openIds.includes(id)) ?? openIds[0];
    if (instanceId === undefined) {
      return null;
    }
    const seeded = yield* seedModel(sql, open, modelIds, undefined, unrunnable);
    return seeded === null
      ? null
      : { connectorInstanceId: seeded.connectorInstanceId ?? instanceId, model: seeded.model };
  }).pipe(Effect.catch(() => Effect.succeed(null)));

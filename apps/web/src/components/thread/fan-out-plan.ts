/**
 * "Compare models" on New task, as plain data: which models are chosen, why
 * sending is refused, and the lanes a send fans out into — one new thread per
 * model, each in its own new worktree. `background-start.ts` runs the lanes.
 *
 * Nothing here knows how the picker is drawn. A pick is the picker's
 * `ModelPick` (compared by `encodeModelPick`), and the catalog's `ModelOption`
 * says what that model accepts.
 *
 * Branch names: the server slugs a worktree name with `branchSlug`, which
 * keeps at most `BRANCH_SLUG_MAX` characters, so a long task text would cut
 * the model suffix off and every lane would get the same branch name plus
 * `-2`, `-3`. `fanOutWorktreeName` shortens the task part instead and hands
 * over a name that is already a slug, which the server keeps as it is (and
 * still suffixes when two lanes collide — one model on two instances).
 */

import { BRANCH_SLUG_MAX, branchSlug } from "@poseidon/shared/branchSlug";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { Effort, RuntimeMode } from "@poseidon/contracts/enums";
import type { ConnectorInstanceId, ThreadId } from "@poseidon/contracts/ids";

import { worktreeName } from "@/components/thread/start-in-worktree";
import { encodeModelPick, type ModelPick } from "@/lib/model-picks";

import type { BackgroundLane } from "./background-start";

/** At most this many models are compared in one send. */
export const COMPARE_MAX = 4;

/** The longest model suffix a fan-out branch carries. */
const MODEL_SUFFIX_MAX = 16;

/** The longest task part of a fan-out thread's title, before the model. */
const TITLE_TASK_MAX = 60;

/**
 * Adds `pick` while fewer than `COMPARE_MAX` are chosen, removes it when it is
 * already chosen. At the cap an unchosen pick leaves the list as it was.
 */
export const toggleComparePick = (
  picks: ReadonlyArray<ModelPick>,
  pick: ModelPick,
): ReadonlyArray<ModelPick> => {
  const key = encodeModelPick(pick);
  if (picks.some((chosen) => encodeModelPick(chosen) === key)) {
    return picks.filter((chosen) => encodeModelPick(chosen) !== key);
  }
  return picks.length >= COMPARE_MAX ? picks : [...picks, pick];
};

/** Why a compare send is not possible yet, or null when it is. */
export const compareRefusal = (input: {
  readonly worktreeAllowed: boolean;
  readonly pickCount: number;
}): string | null => {
  if (!input.worktreeAllowed) {
    return "Compare models needs a git repository — each model works in its own worktree";
  }
  if (input.pickCount < 2) {
    return "Pick at least two models to compare";
  }
  return null;
};

/**
 * A slug no longer than `max`, cut at a dash when one falls inside the limit
 * — the same cut `branchSlug` makes at its own limit.
 */
const capSlug = (slug: string, max: number): string => {
  if (slug.length <= max) {
    return slug;
  }
  const boundary = slug.slice(0, max + 1).lastIndexOf("-");
  const cut = boundary > 0 ? slug.slice(0, boundary) : slug.slice(0, max);
  return cut.replace(/-+$/g, "");
};

/**
 * `<task>-<model>` as a finished slug of at most `BRANCH_SLUG_MAX`
 * characters: `branchSlug(result) === result`, so the model suffix survives
 * the server's slugging.
 */
export const fanOutWorktreeName = (taskText: string, modelLabel: string): string => {
  const suffix = capSlug(branchSlug(modelLabel), MODEL_SUFFIX_MAX);
  const head = capSlug(branchSlug(worktreeName(taskText)), BRANCH_SLUG_MAX - suffix.length - 1);
  return `${head}-${suffix}`;
};

/** `<first line of the task> · <model>`, the task part cut with an ellipsis. */
export const fanOutTitle = (taskText: string, modelLabel: string): string => {
  const firstLine =
    taskText
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "New thread";
  const task =
    firstLine.length > TITLE_TASK_MAX
      ? `${firstLine.slice(0, TITLE_TASK_MAX - 1).trimEnd()}…`
      : firstLine;
  return `${task} · ${modelLabel}`;
};

/** One chosen model, with its catalog entry when the catalog lists it. */
export interface ComparePick {
  readonly pick: ModelPick;
  readonly option: ModelOption | undefined;
}

export interface FanOutInput {
  readonly text: string;
  readonly picks: ReadonlyArray<ComparePick>;
  /** What the New task controls are set to; kept per lane only where the lane accepts it. */
  readonly base: {
    readonly effort?: Effort;
    readonly runtimeMode?: RuntimeMode;
    readonly ultracode?: boolean;
  };
  /** The modes an instance's sessions can honour (its capabilities' `runtimeModes`). */
  readonly runtimeModesFor: (instanceId: ConnectorInstanceId | null) => ReadonlyArray<RuntimeMode>;
  /** Whether the pick's instance and model can run ultracode (`ultracodeOfferedIn`). */
  readonly ultracodeOffered: (pick: ModelPick) => boolean;
  /** The branch every lane's worktree is cut from; absent means the default branch. */
  readonly baseBranch: string | undefined;
  readonly mintThreadId: () => ThreadId;
}

/** A lane with everything a fan-out lane always has. */
export interface FanOutLane extends BackgroundLane {
  readonly title: string;
  /** The model's name, for the toast. */
  readonly label: string;
  readonly worktree: NonNullable<BackgroundLane["worktree"]>;
}

/**
 * One lane per pick, in pick order. An effort the model does not list, or a
 * mode the instance cannot run, is left out, so the server's default for
 * that lane applies instead of a refusal. Ultracode, when it is on, goes only
 * to the lanes that can run it; the others start with it off.
 */
export const planFanOut = (input: FanOutInput): ReadonlyArray<FanOutLane> =>
  input.picks.map(({ pick, option }) => {
    const label = option?.label ?? pick.model;
    const { effort, runtimeMode, ultracode } = input.base;
    return {
      threadId: input.mintThreadId(),
      title: fanOutTitle(input.text, label),
      label,
      worktree: {
        name: fanOutWorktreeName(input.text, label),
        ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
      },
      settings: {
        model: pick.model,
        ...(pick.connectorInstanceId === null
          ? {}
          : { connectorInstanceId: pick.connectorInstanceId }),
        ...(runtimeMode !== undefined &&
        input.runtimeModesFor(pick.connectorInstanceId).includes(runtimeMode)
          ? { runtimeMode }
          : {}),
        ...(effort !== undefined && option?.efforts.includes(effort) === true ? { effort } : {}),
        ...(ultracode === true && input.ultracodeOffered(pick) ? { ultracode: true } : {}),
      },
    };
  });

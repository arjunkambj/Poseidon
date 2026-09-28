/**
 * The pure half of every "Generate" in the renderer — the commit and pull
 * request dialogs' buttons, the combined "Commit, push & create PR" run and
 * Regenerate title: whether generation can run at all, one cancellable run at
 * a time, and a notice said once per app session.
 *
 * Generation is available once the server is reachable and any enabled
 * connector declares `textGeneration`. A connector that is not open carries no
 * capabilities, so it does not count. Otherwise every entry point is disabled
 * with the reason, which names Settings → Connectors.
 *
 * `makeGenerationRunner` holds the run in flight. Cancel aborts its signal —
 * the client runtime interrupts the RPC and the server stops the harness — and
 * forgets it, so a result that lands afterwards is dropped rather than
 * written over what the user has now.
 */

import type { ConnectorSummary } from "@poseidon/contracts/connectors";

/** A generation's answer, or the server's reason it wrote nothing. */
export type GenerationOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

export const GENERATION_OFFLINE = "Not connected to the server.";
export const GENERATION_UNAVAILABLE =
  "No harness can write text — turn one on in Settings → Connectors.";
const GENERATION_LOADING = "Checking which harnesses can write text…";

/**
 * Why nothing can generate text right now; `null` when something can.
 * `connectors` is `null` while the list has not answered yet.
 */
export const generationBlockedReason = (input: {
  readonly connected: boolean;
  readonly connectors: ReadonlyArray<ConnectorSummary> | null;
}): string | null => {
  if (!input.connected) {
    return GENERATION_OFFLINE;
  }
  if (input.connectors === null) {
    return GENERATION_LOADING;
  }
  return input.connectors.some(
    (connector) => connector.enabled && connector.capabilities?.textGeneration === true,
  )
    ? null
    : GENERATION_UNAVAILABLE;
};

export interface GenerationRunner {
  /** Whether a run is in flight. */
  readonly running: () => boolean;
  /**
   * Runs `call` unless one already runs. Resolves with its outcome, or with
   * `null` when it did not start or was cancelled before it answered.
   */
  readonly start: <A>(
    call: (signal: AbortSignal) => Promise<GenerationOutcome<A>>,
  ) => Promise<GenerationOutcome<A> | null>;
  /** Stops the run in flight, if any; its late answer is dropped. */
  readonly cancel: () => void;
}

export const makeGenerationRunner = (
  onRunningChange: (running: boolean) => void,
): GenerationRunner => {
  let current: AbortController | null = null;

  const start = async <A>(
    call: (signal: AbortSignal) => Promise<GenerationOutcome<A>>,
  ): Promise<GenerationOutcome<A> | null> => {
    if (current !== null) {
      return null;
    }
    const controller = new AbortController();
    current = controller;
    onRunningChange(true);
    let outcome: GenerationOutcome<A>;
    try {
      outcome = await call(controller.signal);
    } catch (error) {
      outcome = {
        ok: false,
        message: error instanceof Error && error.message !== "" ? error.message : "Unknown error",
      };
    }
    if (current !== controller) {
      return null;
    }
    current = null;
    onRunningChange(false);
    return outcome;
  };

  const cancel = () => {
    const controller = current;
    if (controller === null) {
      return;
    }
    current = null;
    controller.abort();
    onRunningChange(false);
  };

  return { running: () => current !== null, start, cancel };
};

const noticed = new Set<string>();

/**
 * Shows `notice` — the chosen Writing model was passed over — the first time
 * this app session sees it, and never again after.
 */
export const noticeOnce = (notice: string | undefined, show: (notice: string) => void): void => {
  if (notice === undefined || noticed.has(notice)) {
    return;
  }
  noticed.add(notice);
  show(notice);
};

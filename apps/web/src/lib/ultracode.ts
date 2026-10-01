/**
 * The effort menu's Ultracode entry: when it is offered, what a pick sends
 * and how the other pickers' patches keep the flag truthful.
 *
 * Ultracode is a harness session mode: `xhigh` effort plus standing
 * multi-agent workflow orchestration. It is offered, as the top entry of the
 * effort menu (`./effort-menu`), where the harness says it can switch it
 * (`capabilities.ultracode`) and the model has an `xhigh` rung — the
 * harness's own gate, since ultracode runs at `xhigh`. The patches follow the
 * rules the server keeps (`apps/server/src/orchestration/settingsRules.ts`),
 * so New task's local settings, which only reach the server with
 * `thread.create`, read the same: on sets `xhigh`, off keeps the effort, an
 * effort pick turns it off.
 */

import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import type { ModelOption } from "@poseidon/contracts/connectors";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import type { ThreadSettingsPatch } from "@poseidon/contracts/orchestration";
import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";

import { findModel } from "./model-picks";

/** Whether a harness with `capabilities` can run `model` in ultracode. */
export const ultracodeOffered = (
  capabilities: ConnectorCapabilities | null | undefined,
  model: Pick<ModelOption, "efforts"> | null | undefined,
): boolean => capabilities?.ultracode === true && (model?.efforts.includes("xhigh") ?? false);

/** `ultracodeOffered` for `model` under an instance of the model catalog. */
export const ultracodeOfferedIn = (
  catalog: ReadonlyArray<ConnectorModels>,
  connectorInstanceId: ConnectorInstanceId | null,
  model: string | undefined,
): boolean =>
  model !== undefined &&
  ultracodeOffered(
    catalog.find((entry) => entry.connector.connectorInstanceId === connectorInstanceId)?.connector
      .capabilities,
    findModel(catalog, { connectorInstanceId, model }),
  );

/** What switching ultracode sends: on runs at `xhigh`, off keeps the effort. */
export const ultracodePatch = (on: boolean): ThreadSettingsPatch =>
  on ? { ultracode: true, effort: "xhigh" } : { ultracode: false };

/**
 * `patch` from another control, with ultracode switched off where it no
 * longer holds: an effort pick, or a model ultracode is not offered on.
 * `offeredOn` answers for the model and instance the patch moves to.
 */
export const settleUltracode = (
  patch: ThreadSettingsPatch,
  on: boolean,
  offeredOn: (connectorInstanceId: ConnectorInstanceId | null, model: string) => boolean,
  connectorInstanceId: ConnectorInstanceId | null,
): ThreadSettingsPatch => {
  if (!on || patch.ultracode !== undefined) {
    return patch;
  }
  const leaves =
    patch.effort !== undefined ||
    (patch.model !== undefined &&
      !offeredOn(patch.connectorInstanceId ?? connectorInstanceId, patch.model));
  return leaves ? { ...patch, ultracode: false } : patch;
};

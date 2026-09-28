/**
 * The harness's own slash commands for the `/` menu's Harness group, as the
 * thread's connector instance lists them (`connectors.commands.list`). Only a
 * successful answer counts: while the listing loads, and when the handshake
 * behind it fails, the menu simply has no Harness group, never an error.
 */

import { useAtomValue } from "@effect/atom-react";
import type { ConnectorInstanceId, ProjectId } from "@poseidon/contracts/ids";
import type { HarnessCommand } from "@poseidon/contracts/harnessCommands";
import { AsyncResult } from "effect/unstable/reactivity";

import { useClientRuntime } from "@/lib/client-runtime";

const NO_COMMANDS: ReadonlyArray<HarnessCommand> = [];

export function useHarnessCommands(
  instanceId: ConnectorInstanceId | null,
  projectId: ProjectId,
): ReadonlyArray<HarnessCommand> {
  const { harnessCommandsAtom } = useClientRuntime();
  const result = useAtomValue(harnessCommandsAtom(instanceId)(projectId));
  return AsyncResult.isSuccess(result) ? result.value : NO_COMMANDS;
}

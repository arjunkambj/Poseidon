/**
 * Which connector instance a thread's models come from.
 *
 * A thread binds a session only on its first `thread.turn.requested`, so before
 * the first turn `doc.session` is null. The header picker and the composer's
 * `/model` menu both asked `connectorModelsAtom` for that null instance, which
 * short-circuits to an empty list — so on a brand-new thread the Model picker
 * held exactly one entry, the raw id of the current model, and `/model` read
 * "No options". Both filled in the moment a message was sent, which is after
 * the point where choosing a model is useful.
 *
 * Until a session exists, the honest answer is the instance the thread *would*
 * route to, which is the server's rule in `ConnectorSelection`: the instance
 * the thread chose (`settings.connectorInstanceId`) while it is still there to
 * run on, else the default rule in `apps/server/src/settings/connectorRouting.ts`
 * — the first enabled connector in the order the settings document lists them
 * that can run and is also open. `connectors.list` answers in that same
 * document order, so the client reads the document half of the rule off it,
 * and "can run" off each summary's probe (`probeCanRun`, the server's own
 * reading): an instance whose harness is not installed or is signed out goes
 * behind every one that can, and when none can the first enabled one stays
 * first, so the health banner has something to explain. A probe still running
 * counts as able, so the picker does not empty or jump while probes land.
 *
 * It deliberately stops there. Openness is a registry fact the client cannot
 * see. So when the instance is enabled but fails to open, the picker lists its
 * models while the turn will actually run on the next one. That window is
 * narrow and self-correcting: the thread binds a session on its first turn and
 * `bound` takes over from then on, and a connector that cannot open is a
 * connector the user has to fix anyway.
 *
 * Only for *listing* models and what the harness can do. The switch
 * behaviour (`modelSwitch`, `effortSwitch`) stays keyed on the bound session: a
 * fresh session consumes whatever the thread's settings say, so a not-yet-bound
 * connector's `restart` switch must not lock the picker before there is
 * anything to restart.
 */

import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { probeCanRun, type ConnectorSummary } from "@poseidon/contracts/connectors";
import type { ConnectorCapabilities } from "@poseidon/contracts/runtime";

/**
 * The default rule's order over anything that carries a connector summary:
 * the ones whose probe says they can run, in the order given, then the rest in
 * that order too. New task's model (`newTaskModelPick`) walks the same order,
 * so what it shows is where the thread would go.
 */
export const runnableFirst = <A>(
  items: ReadonlyArray<A>,
  summaryOf: (item: A) => ConnectorSummary,
): ReadonlyArray<A> => [
  ...items.filter((item) => probeCanRun(summaryOf(item).probe)),
  ...items.filter((item) => !probeCanRun(summaryOf(item).probe)),
];

export const threadConnectorInstanceId = (
  bound: ConnectorInstanceId | null | undefined,
  chosen: ConnectorInstanceId | null | undefined,
  connectors: ReadonlyArray<ConnectorSummary>,
): ConnectorInstanceId | null => {
  if (bound != null) {
    return bound;
  }
  const enabled = connectors.filter((connector) => connector.enabled);
  return (
    enabled.find((connector) => connector.connectorInstanceId === chosen)?.connectorInstanceId ??
    runnableFirst(enabled, (connector) => connector)[0]?.connectorInstanceId ??
    null
  );
};

/**
 * The capabilities of the instance a thread runs on — or would, before its
 * first turn (`threadConnectorInstanceId`). What the harness *is* able to do
 * (which runtime modes it honours, whether it takes images) does not wait for
 * a session, unlike the switch behaviour above. `null` until that instance has
 * opened and reported them.
 */
export const instanceCapabilities = (
  instanceId: ConnectorInstanceId | null,
  connectors: ReadonlyArray<ConnectorSummary>,
): ConnectorCapabilities | null =>
  connectors.find((c) => c.connectorInstanceId === instanceId)?.capabilities ?? null;

/**
 * Which connector instances the Customize page shows a section for. Skills
 * and MCP servers live in each harness's own files, so every enabled instance
 * whose summary says it manages that kind gets a section of its own, in the
 * connectors page's order. A disabled or unopened instance manages nothing.
 */

import type { ConnectorSummary } from "@poseidon/contracts/connectors";

/** The kinds whose Customize tab counts every instance's list. */
export type ExtensionKind = Extract<keyof ConnectorSummary["extensions"], "skills" | "mcpServers">;

/**
 * Every per-instance extension. The Plugins tab lists each instance's own
 * plugins too, but counts Poseidon's plugins alongside them.
 */
export type InstanceExtension = keyof ConnectorSummary["extensions"];

export const instancesWith = (
  connectors: ReadonlyArray<ConnectorSummary>,
  kind: InstanceExtension,
): ReadonlyArray<ConnectorSummary> =>
  connectors.filter((connector) => connector.enabled && connector.extensions[kind]);

/**
 * The tab count: every instance's list added up, or `null` until each one
 * has answered — a partial sum would read as a real, smaller count.
 */
export const totalCount = (lengths: ReadonlyArray<number | null>): number | null =>
  lengths.some((length) => length === null)
    ? null
    : lengths.reduce<number>((sum, length) => sum + (length ?? 0), 0);

/**
 * What the translator produces, and the readers it reads app-server messages
 * with.
 *
 * The protocol grows with nearly every release, so the translator reads
 * messages as plain records and names only the members it uses. A member it
 * does not find is treated as absent, never as a crash.
 */

import type { RuntimeEvent } from "@poseidon/contracts/runtime";

/** A `RuntimeEvent` minus the envelope fields the session stamps on the way out. */
type WithoutEnvelope<Event> = Event extends RuntimeEvent
  ? Omit<Event, "eventId" | "connectorInstanceId" | "threadId" | "createdAt">
  : never;

export type PendingRuntimeEvent = WithoutEnvelope<RuntimeEvent>;

/** Where every `raw` this connector attaches comes from. */
export const RAW_SOURCE = "codex.app-server";

export type Json = Readonly<Record<string, unknown>>;

export const asRecord = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const asArray = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

/** A non-negative integer, for the token counts the contract requires. */
export const tokens = (value: unknown): number => Math.max(0, Math.trunc(asNumber(value) ?? 0));

/** A string that is not empty, or undefined — for the contract's `NonEmptyString`s. */
export const nonEmpty = (value: unknown): string | undefined => {
  const text = asString(value);
  return text === undefined || text === "" ? undefined : text;
};

/** One notification from the server, as the JSON-RPC client hands it on. */
export interface Notification {
  readonly method: string;
  readonly params: unknown;
}

/** The notification kept whole, so a protocol change shows up instead of vanishing. */
export const unmapped = (notification: Notification): PendingRuntimeEvent => ({
  type: "event.unmapped",
  payload: {},
  raw: { source: RAW_SOURCE, method: notification.method, payload: notification.params ?? null },
});

/** 64KB of a tool's output: a useful head, and the cut marked. */
export const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;

export const truncateToolOutput = (text: string): string =>
  text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}...[truncated]`
    : text;

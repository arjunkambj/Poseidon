/**
 * The notifications a recorded app-server launch sent, in order, for the
 * translator's unit tests.
 */

import { loadStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";

import { CODEX_KIND } from "../src/kind";
import type { Notification } from "../src/translate/pending";

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Every notification of `scenario`'s app-server launch number `launch` (from 0). */
export const recordedNotifications = (
  scenario: string,
  launch = 0,
): ReadonlyArray<Notification> => {
  const servers = loadStdioJsonRpcRecording(CODEX_KIND, scenario).invocations.filter((invocation) =>
    invocation.argv.includes("app-server"),
  );
  const invocation = servers[launch];
  if (invocation === undefined) throw new Error(`${scenario} has no app-server launch ${launch}`);
  return invocation.frames.flatMap((frame) => {
    const data = frame.data;
    return frame.dir === "from-harness" &&
      frame.channel === "stdout" &&
      isObject(data) &&
      typeof data.method === "string" &&
      !("id" in data)
      ? [{ method: data.method, params: data.params }]
      : [];
  });
};

/** Every request `scenario`'s app-server launch number `launch` made of the connector. */
export const recordedServerRequests = (
  scenario: string,
  launch = 0,
): ReadonlyArray<{
  readonly id: number | string;
  readonly method: string;
  readonly params: unknown;
}> => {
  const servers = loadStdioJsonRpcRecording(CODEX_KIND, scenario).invocations.filter((invocation) =>
    invocation.argv.includes("app-server"),
  );
  const invocation = servers[launch];
  if (invocation === undefined) throw new Error(`${scenario} has no app-server launch ${launch}`);
  return invocation.frames.flatMap((frame) => {
    const data = frame.data;
    return frame.dir === "from-harness" &&
      frame.channel === "stdout" &&
      isObject(data) &&
      typeof data.method === "string" &&
      (typeof data.id === "number" || typeof data.id === "string")
      ? [{ id: data.id, method: data.method, params: data.params }]
      : [];
  });
};

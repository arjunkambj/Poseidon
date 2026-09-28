/**
 * Which thread each imported session became, kept in
 * `POSEIDON_HOME/session-imports.json` as `{ "<instanceId>:<sourceId>": threadId }`.
 *
 * It is how a second import of the same session answers the thread the first
 * one made, and how the list marks a session as already imported. It holds
 * nothing the event log needs: a lost or unreadable ledger only means a
 * session can be imported once more. Every write goes to a temporary file
 * that is then renamed over the ledger, so a crash mid-write leaves the old
 * ledger whole rather than half of a new one.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { ConnectorInstanceId, ThreadId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";

/** The ledger's file name under `POSEIDON_HOME`. */
export const LEDGER_FILE = "session-imports.json";

/** Source key → the thread its import made. */
export type ImportLedger = Readonly<Record<string, ThreadId>>;

/** The ledger key of one harness session, read through one instance. */
export const ledgerKey = (instanceId: ConnectorInstanceId, sourceId: string): string =>
  `${instanceId}:${sourceId}`;

const isLedger = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The ledger at `path`; empty when there is none yet. A file that does not
 * parse is logged and read as empty, and the next import writes a good one.
 */
export const readLedger = (path: string): Effect.Effect<ImportLedger> =>
  Effect.tryPromise(async () => {
    const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (text === null) return {};
    const parsed: unknown = JSON.parse(text);
    if (!isLedger(parsed)) throw new Error("not a JSON object");
    const ledger: Record<string, ThreadId> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") ledger[key] = value as ThreadId;
    }
    return ledger;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `session import ledger ${path} is unreadable; treating it as empty`,
        error,
      ).pipe(Effect.as({})),
    ),
  );

/** Replaces the ledger at `path` with `ledger`, through a temporary file and a rename. */
export const writeLedger = (path: string, ledger: ImportLedger): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(NodePath.dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });

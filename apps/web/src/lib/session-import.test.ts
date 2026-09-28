import type { ConnectorInstanceId, ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { ImportableSessionEntry } from "@poseidon/contracts/sessionImport";
import { describe, expect, it } from "vitest";

import {
  folderName,
  groupSessions,
  isSelectable,
  rowState,
  runImports,
  sessionKey,
  type ImportOutcome,
  type RowState,
} from "./session-import";

const entry = (
  sourceId: string,
  cwd: string,
  updatedAt: string,
  extra: Partial<ImportableSessionEntry> = {},
): ImportableSessionEntry => ({
  sourceId,
  cwd,
  title: `Session ${sourceId}`,
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
  connectorInstanceId: "harness-a" as ConnectorInstanceId,
  connectorKind: "harness",
  connectorName: "Harness A",
  projectId: null,
  importedThreadId: null,
  ...extra,
});

describe("folderName", () => {
  it("is the last segment of a path, ignoring a trailing separator", () => {
    expect(folderName("/Users/me/code/app")).toBe("app");
    expect(folderName("/Users/me/code/app/")).toBe("app");
    expect(folderName("C:\\work\\site")).toBe("site");
    expect(folderName("/")).toBe("/");
  });
});

describe("groupSessions", () => {
  it("groups by folder, the newest group first and newest first inside one", () => {
    const groups = groupSessions([
      entry("a", "/code/app", "2026-01-02T00:00:00.000Z"),
      entry("b", "/code/site", "2026-01-05T00:00:00.000Z"),
      entry("c", "/code/app", "2026-01-04T00:00:00.000Z"),
      entry("d", "/code/site", "2026-01-01T00:00:00.000Z"),
    ]);
    expect(
      groups.map((group) => [group.name, group.cwd, group.entries.map((e) => e.sourceId)]),
    ).toEqual([
      ["site", "/code/site", ["b", "d"]],
      ["app", "/code/app", ["c", "a"]],
    ]);
  });

  it("notes the project already open on a folder", () => {
    const [group] = groupSessions([
      entry("a", "/code/app", "2026-01-02T00:00:00.000Z"),
      entry("b", "/code/app", "2026-01-01T00:00:00.000Z", { projectId: "p1" as ProjectId }),
    ]);
    expect(group?.projectId).toBe("p1");
    expect(groupSessions([entry("a", "/x", "2026-01-01T00:00:00.000Z")])[0]?.projectId).toBe(null);
  });

  it("is empty for no sessions", () => {
    expect(groupSessions([])).toEqual([]);
  });
});

describe("rowState", () => {
  it("prefers what the page did, then the thread the list names, then idle", () => {
    const fresh = entry("a", "/x", "2026-01-01T00:00:00.000Z");
    const held = entry("b", "/x", "2026-01-01T00:00:00.000Z", {
      importedThreadId: "t1" as ThreadId,
    });
    const states = new Map<string, RowState>([
      [sessionKey(fresh), { status: "failed", message: "gone" }],
    ]);
    expect(rowState(fresh, states)).toEqual({ status: "failed", message: "gone" });
    expect(rowState(held, states)).toEqual({ status: "imported", threadId: "t1" });
    expect(rowState(fresh, new Map())).toEqual({ status: "idle" });
  });

  it("lets only idle and failed rows be ticked", () => {
    expect(isSelectable({ status: "idle" })).toBe(true);
    expect(isSelectable({ status: "failed", message: "x" })).toBe(true);
    expect(isSelectable({ status: "queued" })).toBe(false);
    expect(isSelectable({ status: "importing" })).toBe(false);
    expect(isSelectable({ status: "imported", threadId: "t" as ThreadId })).toBe(false);
  });
});

/** Records every state change in order, as `key:status`. */
const recorder = () => {
  const log: Array<string> = [];
  const onState = (key: string, state: RowState) => log.push(`${key}:${state.status}`);
  return { log, onState };
};

const ok = (key: string): ImportOutcome => ({ ok: true, threadId: `t-${key}` as ThreadId });

describe("runImports", () => {
  it("queues every row, then imports them one at a time in order", async () => {
    const { log, onState } = recorder();
    let running = 0;
    let most = 0;
    const run = runImports(
      ["a", "b"],
      async (key) => {
        running += 1;
        most = Math.max(most, running);
        await Promise.resolve();
        running -= 1;
        return ok(key);
      },
      onState,
    );
    await run.done;
    expect(most).toBe(1);
    expect(log).toEqual([
      "a:queued",
      "b:queued",
      "a:importing",
      "a:imported",
      "b:importing",
      "b:imported",
    ]);
  });

  it("keeps going past a failed row, whether it answered a failure or threw", async () => {
    const states = new Map<string, RowState>();
    const run = runImports(
      ["a", "b", "c"],
      async (key) => {
        if (key === "a") return { ok: false, message: "folder is gone" };
        if (key === "b") throw new Error("socket closed");
        return ok(key);
      },
      (key, state) => states.set(key, state),
    );
    await run.done;
    expect(states.get("a")).toEqual({ status: "failed", message: "folder is gone" });
    expect(states.get("b")).toEqual({ status: "failed", message: "socket closed" });
    expect(states.get("c")).toEqual({ status: "imported", threadId: "t-c" });
  });

  it("stops after the row being imported and puts the queued rows back to idle", async () => {
    const { log, onState } = recorder();
    let release: () => void = () => {};
    const run = runImports(
      ["a", "b", "c"],
      (key) =>
        new Promise((resolve) => {
          release = () => resolve(ok(key));
        }),
      onState,
    );
    await Promise.resolve();
    // Two rows are still queued; stopping again, or after the end, puts back none.
    expect(run.stop()).toBe(2);
    expect(run.stop()).toBe(0);
    release();
    await run.done;
    expect(run.stop()).toBe(0);
    expect(log).toEqual([
      "a:queued",
      "b:queued",
      "c:queued",
      "a:importing",
      "a:imported",
      "b:idle",
      "c:idle",
    ]);
  });

  it("retries one row on its own", async () => {
    const { log, onState } = recorder();
    await runImports(["b"], async (key) => ok(key), onState).done;
    expect(log).toEqual(["b:queued", "b:importing", "b:imported"]);
  });
});

/**
 * The files a turn's diff wrote that no file-change item names — and the
 * recorded `edit-approval` turn, whose one diff is its one gated change.
 */

import { loadStdioJsonRpcRecording } from "@poseidon/testkit/stdioJsonRpcRecording";
import { describe, expect, it } from "vitest";

import { CODEX_KIND } from "./kind";
import { asRecord, asString } from "./translate/pending";
import { diffPaths, makeTurnWrites } from "./turnWrites";

const diffOf = (...paths: ReadonlyArray<string>): string =>
  paths
    .map(
      (path) =>
        `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+hi\n`,
    )
    .join("");

describe("diffPaths", () => {
  it("reads each file header's written side, once", () => {
    expect(diffPaths(diffOf("a.txt", "dir/b.txt", "a.txt"))).toEqual(["a.txt", "dir/b.txt"]);
    expect(diffPaths("diff --git a/old.txt b/new.txt\nrename from old.txt\n")).toEqual(["new.txt"]);
    expect(diffPaths("")).toEqual([]);
  });
});

describe("makeTurnWrites", () => {
  const fileChange = (path: string) => ({
    item: { type: "fileChange", id: "f1", changes: [{ path }] },
  });

  it("counts a diff path no file-change item names", () => {
    const writes = makeTurnWrites();
    writes.observe("item/started", fileChange("/repo/a.txt"));
    writes.observe("turn/diff/updated", { diff: diffOf("a.txt", "b.txt") });
    expect(writes.unaccounted()).toBe(1);
  });

  it("reads each update as the whole diff so far, and forgets it on clear", () => {
    const writes = makeTurnWrites();
    writes.observe("turn/diff/updated", { diff: diffOf("a.txt") });
    writes.observe("turn/diff/updated", { diff: diffOf("a.txt", "b.txt") });
    expect(writes.unaccounted()).toBe(2);
    writes.clear();
    expect(writes.unaccounted()).toBe(0);
  });

  it("does not match a path by a partial file name", () => {
    const writes = makeTurnWrites();
    writes.observe("item/completed", fileChange("/repo/xa.txt"));
    writes.observe("turn/diff/updated", { diff: diffOf("a.txt") });
    expect(writes.unaccounted()).toBe(1);
  });

  it("finds every write of the recorded edit-approval turn accounted for", () => {
    const writes = makeTurnWrites();
    let diffs = 0;
    for (const invocation of loadStdioJsonRpcRecording(CODEX_KIND, "edit-approval").invocations) {
      for (const frame of invocation.frames) {
        if (frame.dir !== "from-harness") continue;
        const message = asRecord(frame.data);
        const method = asString(message.method);
        if (method === undefined || "id" in message) continue;
        if (method === "turn/diff/updated") diffs += 1;
        writes.observe(method, asRecord(message.params));
      }
    }
    expect(diffs).toBeGreaterThan(0);
    expect(writes.unaccounted()).toBe(0);
  });
});

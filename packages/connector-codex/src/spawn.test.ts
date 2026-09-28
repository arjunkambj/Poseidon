/**
 * The process group: a child that leaves on stdin's end, one that ignores it
 * and its grandchild, and a spawn that never started. Live clock: the stop's
 * graces are real time.
 */

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { isGroupGone, makeProcessGroup } from "./spawn";

const env = { PATH: process.env.PATH ?? "" };

describe("makeProcessGroup", () => {
  it.live("closes stdin first, and a child that leaves on it exits cleanly", () =>
    Effect.gen(function* () {
      const group = makeProcessGroup();
      const child = group.spawn({
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
        env,
      });
      expect(child.pid).toBeGreaterThan(0);
      yield* group.stop;
      expect(yield* Effect.promise(() => child.exited)).toEqual({ code: 0, signal: null });
      expect(yield* group.isGone).toBe(true);
    }),
  );

  it.live("signals the whole group when the child ignores its stdin, grandchild included", () =>
    Effect.gen(function* () {
      const group = makeProcessGroup();
      const child = group.spawn({
        command: "/bin/sh",
        args: ["-c", "sleep 60 & echo $!; while true; do sleep 1; done"],
        env,
      });
      child.stdout.setEncoding("utf8");
      const printed = yield* Effect.promise(
        () => new Promise<string>((resolve) => child.stdout.once("data", resolve)),
      );
      const grandchild = Number(printed.trim());
      expect(grandchild).toBeGreaterThan(0);
      yield* group.stop;
      expect((yield* Effect.promise(() => child.exited)).signal).toBe("SIGTERM");
      expect(isGroupGone(child.pid)).toBe(true);
      expect(() => process.kill(grandchild, 0)).toThrow();
      expect(yield* group.isGone).toBe(true);
    }),
  );

  it.live("reports a child that never started, and keeps its stderr tail", () =>
    Effect.gen(function* () {
      const group = makeProcessGroup();
      const missing = group.spawn({ command: "/nonexistent/codex", args: [], env });
      const exit = yield* Effect.promise(() => missing.exited);
      expect(exit.error).toContain("ENOENT");
      expect(missing.pid).toBe(-1);

      const noisy = group.spawn({
        command: process.execPath,
        args: ["-e", "process.stderr.write('first\\nlast words\\n')"],
        env,
      });
      yield* Effect.promise(() => noisy.exited);
      yield* group.stop;
      expect(noisy.stderrTail()).toBe("first\nlast words\n");
      expect(yield* group.isGone).toBe(true);
    }),
  );
});

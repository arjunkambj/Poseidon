import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_MESSAGES,
  TranscriptWindow,
  readJsonLines,
  titleFromPrompt,
} from "./sessionFiles";

describe("titleFromPrompt", () => {
  it("keeps a short prompt, whitespace collapsed", () => {
    expect(titleFromPrompt("  Fix the\n\nbuild  ")).toBe("Fix the build");
  });

  it("cuts a long prompt at a word", () => {
    const title = titleFromPrompt(`${"word ".repeat(30)}end`);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).toMatch(/word…$/);
  });
});

describe("TranscriptWindow", () => {
  it("joins an assistant reply's parts by key, and not across a user message", () => {
    const window = new TranscriptWindow();
    window.add({ role: "user", text: "one" });
    window.add({ role: "assistant", text: "a" }, "m1");
    window.add({ role: "assistant", text: "b" }, "m1");
    window.add({ role: "user", text: "two" });
    window.add({ role: "assistant", text: "c" }, "m1");
    expect(window.messages().map((message) => message.text)).toEqual(["one", "a\n\nb", "two", "c"]);
    expect(window.count).toBe(4);
    expect(window.firstPrompt).toBe("one");
  });

  it("keeps the newest messages within the caps, counting them all", () => {
    const window = new TranscriptWindow();
    const total = MAX_TRANSCRIPT_MESSAGES * 3;
    for (let index = 0; index < total; index += 1) {
      window.add({ role: index % 2 === 0 ? "user" : "assistant", text: String(index) });
    }
    const messages = window.messages();
    expect(window.count).toBe(total);
    expect(messages).toHaveLength(MAX_TRANSCRIPT_MESSAGES);
    expect(messages.at(-1)?.text).toBe(String(total - 1));

    const long = new TranscriptWindow();
    for (let index = 0; index < 100; index += 1) {
      long.add({ role: "user", text: "x".repeat(30_000) });
    }
    const kept = long.messages();
    expect(kept.reduce((chars, message) => chars + message.text.length, 0)).toBeLessThanOrEqual(
      MAX_TRANSCRIPT_CHARS,
    );
    expect(kept.length).toBeGreaterThan(0);
  });
});

describe("readJsonLines", () => {
  it.effect("skips lines that do not parse, and a range's cut edges", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "session-lines-"));
      const file = NodePath.join(dir, "lines.jsonl");
      NodeFS.writeFileSync(file, '{"n":1}\nnot json\n\n{"n":2}\n{"n":3}\n');
      const all: Array<unknown> = [];
      yield* readJsonLines(file, (record) => void all.push(record));
      expect(all).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

      // Starting inside `{"n":1}` drops its rest; ending inside `{"n":3}` drops that.
      const ranged: Array<unknown> = [];
      yield* readJsonLines(file, (record) => void ranged.push(record), { start: 2, end: 29 });
      expect(ranged).toEqual([{ n: 2 }]);

      const first: Array<unknown> = [];
      yield* readJsonLines(file, (record) => {
        first.push(record);
        return false;
      });
      expect(first).toEqual([{ n: 1 }]);
    }),
  );

  it.effect("fails for a file that is not there", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        readJsonLines(NodePath.join(NodeOS.tmpdir(), "session-lines-missing.jsonl"), () => {}),
      );
      expect(error.code).toBe("internal");
    }),
  );
});

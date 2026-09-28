import { describe, expect, it } from "vitest";

import { referenceLines } from "./references";
import { userMessage } from "./userMessage";

describe("referenceLines", () => {
  it("names each skill, then each plugin, once and quoted", () => {
    expect(
      referenceLines([
        { kind: "plugin", name: "browser" },
        { kind: "skill", name: "review" },
        { kind: "skill", name: "review" },
        { kind: "plugin", name: "browser" },
        { kind: "skill", name: 'say "hi"' },
      ]),
    ).toEqual([
      'Use the "review" skill.',
      'Use the "say \\"hi\\"" skill.',
      'Use the "browser" plugin.',
    ]);
  });

  it("is empty with nothing referenced", () => {
    expect(referenceLines([])).toEqual([]);
  });
});

describe("userMessage references", () => {
  it("puts the reference lines after the mentions and before the attachments", () => {
    const message = userMessage(
      {
        text: "check the page",
        attachments: [],
        mentions: ["src/app.tsx"],
        references: [
          { kind: "plugin", name: "browser" },
          { kind: "skill", name: "browser" },
        ],
      },
      { images: [], promptLines: ["Attached file: /tmp/a.txt"] },
    );
    expect(message.message.content).toBe(
      [
        "check the page",
        "@src/app.tsx",
        'Use the "browser" skill.',
        'Use the "browser" plugin.',
        "Attached file: /tmp/a.txt",
      ].join("\n"),
    );
  });

  it("leaves a turn without references as it was", () => {
    const message = userMessage({ text: "hi", attachments: [], mentions: [] });
    expect(message.message.content).toBe("hi");
  });
});

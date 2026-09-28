import { describe, expect, it } from "vitest";

import { CHAT_WIDTHS, chatWidthClasses, nextChatWidth } from "./chat-width";

describe("chatWidthClasses", () => {
  it("keeps comfortable at the column's original 700px and 684px", () => {
    expect(chatWidthClasses("comfortable")).toEqual({
      timeline: "max-w-[700px]",
      column: "max-w-[684px]",
    });
  });

  it("widens the column for wide and lifts the cap for full", () => {
    expect(chatWidthClasses("wide")).toEqual({
      timeline: "max-w-[960px]",
      column: "max-w-[944px]",
    });
    expect(chatWidthClasses("full")).toEqual({ timeline: "max-w-none", column: "max-w-none" });
  });

  it("gives every width one literal max-w- class per slot", () => {
    for (const { value } of CHAT_WIDTHS) {
      const classes = chatWidthClasses(value);
      for (const cls of [classes.timeline, classes.column]) {
        expect(cls).toMatch(/^max-w-(\[\d+px\]|none)$/);
      }
    }
  });
});

describe("CHAT_WIDTHS", () => {
  it("lists the widths narrowest first with their labels", () => {
    expect(CHAT_WIDTHS).toEqual([
      { value: "comfortable", label: "Comfortable" },
      { value: "wide", label: "Wide" },
      { value: "full", label: "Full" },
    ]);
  });
});

describe("nextChatWidth", () => {
  it("cycles comfortable, wide, full and back", () => {
    expect(nextChatWidth("comfortable")).toBe("wide");
    expect(nextChatWidth("wide")).toBe("full");
    expect(nextChatWidth("full")).toBe("comfortable");
  });
});

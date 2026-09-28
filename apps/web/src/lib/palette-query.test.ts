import { describe, expect, it } from "vitest";

import {
  MESSAGE_HIT_KEYWORD,
  messageSearchQuery,
  paletteFilter,
  paletteQuery,
} from "./palette-query";

describe("paletteQuery", () => {
  it("reads a bare > as commands only with nothing to match", () => {
    expect(paletteQuery(">")).toEqual({ commandsOnly: true, query: "" });
  });

  it("matches the text after the >", () => {
    expect(paletteQuery("> set")).toEqual({ commandsOnly: true, query: "set" });
  });

  it("ignores the whitespace before the >", () => {
    expect(paletteQuery("  >x")).toEqual({ commandsOnly: true, query: "x" });
  });

  it("keeps plain text as a search over everything", () => {
    expect(paletteQuery("fix login")).toEqual({ commandsOnly: false, query: "fix login" });
  });

  it("reads an empty input as no query", () => {
    expect(paletteQuery("")).toEqual({ commandsOnly: false, query: "" });
  });

  it("does not treat a > later in the text as command mode", () => {
    expect(paletteQuery("a > b")).toEqual({ commandsOnly: false, query: "a > b" });
  });
});

describe("paletteFilter", () => {
  it("keeps every entry when there is nothing to match", () => {
    expect(paletteFilter("Settings General", ">")).toBe(1);
    expect(paletteFilter("Settings General", " >  ")).toBe(1);
  });

  it("scores against the text after the > rather than the raw input", () => {
    expect(paletteFilter("Settings General", "> gen")).toBeGreaterThan(0);
    expect(paletteFilter("Toggle sidebar", "> gen")).toBe(0);
  });

  it("scores plain text as it is", () => {
    expect(paletteFilter("Fix login flow", "login")).toBeGreaterThan(0);
    expect(paletteFilter("Fix login flow", "zzz")).toBe(0);
  });

  it("matches keywords too", () => {
    expect(paletteFilter("General", "prefs", ["prefs"])).toBeGreaterThan(0);
  });
});

describe("paletteFilter on message hits", () => {
  it("scores a message hit above zero but below a real title match", () => {
    const title = paletteFilter("Fix login flow", "login");
    const message = paletteFilter("message t-1", "login", [MESSAGE_HIT_KEYWORD]);
    expect(message).toBeGreaterThan(0);
    expect(message).toBeLessThan(title);
  });

  it("keeps a message hit whose own text does not match the query", () => {
    expect(paletteFilter("message t-1", "zzz", [MESSAGE_HIT_KEYWORD])).toBeGreaterThan(0);
  });

  it("gives a message hit the full score when there is nothing to match", () => {
    expect(paletteFilter("message t-1", "", [MESSAGE_HIT_KEYWORD])).toBe(1);
  });
});

describe("messageSearchQuery", () => {
  it("asks for a plain query past two characters", () => {
    expect(messageSearchQuery("  login ")).toBe("login");
    expect(messageSearchQuery("abc")).toBe("abc");
  });

  it("asks nothing for two characters or fewer", () => {
    expect(messageSearchQuery("ab")).toBeNull();
    expect(messageSearchQuery("  ab  ")).toBeNull();
    expect(messageSearchQuery("")).toBeNull();
  });

  it("counts characters rather than UTF-16 units", () => {
    expect(messageSearchQuery("😀😀")).toBeNull();
  });

  it("asks nothing for a command search", () => {
    expect(messageSearchQuery("> settings")).toBeNull();
  });
});

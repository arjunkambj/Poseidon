/**
 * One row of `codex plugin list --json` as a plugin summary: what is kept,
 * and what is not a row at all.
 */

import { describe, expect, it } from "vitest";

import { toPluginSummary } from "./plugins";

describe("toPluginSummary", () => {
  it("keeps the name, marketplace and state, and a local source's directory", () => {
    expect(
      toPluginSummary({
        pluginId: "pdf@runtime",
        name: "pdf",
        marketplaceName: "runtime",
        installed: true,
        enabled: false,
        source: { source: "local", path: "/plugins/pdf" },
      }),
    ).toEqual({
      name: "pdf",
      source: "runtime",
      scope: "user",
      enabled: false,
      dir: "/plugins/pdf",
    });
  });

  it("reads no directory from a source that is not local", () => {
    expect(
      toPluginSummary({ name: "gh", installed: true, enabled: true, source: { source: "git" } }),
    ).toEqual({ name: "gh", scope: "user", enabled: true });
  });

  it("is null for a row that is not installed or names nothing", () => {
    expect(toPluginSummary({ name: "offered", installed: false, enabled: false })).toBeNull();
    expect(toPluginSummary({ installed: true })).toBeNull();
    expect(toPluginSummary("pdf")).toBeNull();
  });
});

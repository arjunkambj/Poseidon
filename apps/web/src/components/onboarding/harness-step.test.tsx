import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { installAppAtoms } from "@/state/app-runtime";

import { HarnessStep } from "./harness-step";

// Home's drawer was left open by an earlier setup, as its stored flag says
// after a command ran there and setup ended.
vi.mock("@/state/terminal-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/terminal-ui")>()),
  useTerminalOpen: () => [true, () => {}] as const,
}));
vi.mock("@/components/run/use-run-script", () => ({
  useRunScript: () => ({ run: async () => {} }),
}));
vi.mock("@/components/terminal/owned-terminal", () => ({
  HomeTerminal: () => <div data-home-terminal="" />,
}));

installAppAtoms(null);

describe("HarnessStep", () => {
  it("mounts no terminal until a command runs, whatever home's drawer remembers", () => {
    const html = renderToStaticMarkup(<HarnessStep />);
    expect(html).toContain("Re-check");
    expect(html).not.toContain("data-home-terminal");
  });
});

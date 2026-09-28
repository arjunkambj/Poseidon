import type { ConnectorProbe, ConnectorSummary } from "@poseidon/contracts/connectors";
import type { ConnectorInstanceId } from "@poseidon/contracts/ids";
import { TooltipProvider } from "@poseidon/ui/components/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LOGO_ICON, LOGO_ICON_KEY } from "@/components/ui/icons/test-logo";

import { HarnessRow } from "./harness-row";

const summary = (probe: Omit<ConnectorProbe, "probedAt">): ConnectorSummary => ({
  connectorInstanceId: "0199c0de-0001-7000-8000-000000000001" as ConnectorInstanceId,
  kind: "harness",
  displayName: "Comet",
  enabled: true,
  capabilities: null,
  extensions: { skills: false, plugins: false, mcpServers: false },
  probe: { ...probe, probedAt: "2026-09-28T00:00:00.000Z" },
});

const render = (row: ConnectorSummary, checking = false, iconKey?: string) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <HarnessRow
        summary={row}
        monogram="Co"
        iconKey={iconKey}
        checking={checking}
        onRun={() => {}}
      />
    </TooltipProvider>,
  );

/** The visible text: style blocks and tags stripped, whitespace collapsed. */
const text = (html: string) =>
  html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("HarnessRow", () => {
  it("shows a spinner and nothing else while the harness is probed", () => {
    const html = render(summary({ status: "probing" }));
    expect(text(html)).toBe("Co Comet Checking…");
    expect(html).toContain("data-honeyicons-spinner");
    expect(html).not.toContain("Run in terminal");
  });

  it("shows a spinner while a Re-check is in flight, over the probe it will replace", () => {
    const html = render(
      summary({ status: "not-installed", installCommand: "npm install -g comet" }),
      true,
    );
    expect(text(html)).toBe("Co Comet Checking…");
  });

  it("offers a missing harness's install command in the terminal", () => {
    const html = render(
      summary({ status: "not-installed", installCommand: "npm install -g comet" }),
    );
    expect(text(html)).toContain("Not installed");
    expect(text(html)).toContain("Install with");
    expect(html).toContain("npm install -g comet");
    expect(text(html)).toContain("Run in terminal");
  });

  it("offers a signed-out harness's sign-in command, with its version", () => {
    const html = render(
      summary({
        status: "not-authenticated",
        installed: true,
        version: "1.2.3",
        auth: "absent",
        loginCommand: "comet login",
      }),
    );
    expect(text(html)).toContain("Not signed in");
    expect(text(html)).toContain("Installed · v1.2.3 Sign in with");
    expect(text(html)).toContain("Sign in with");
    expect(html).toContain("comet login");
    expect(text(html)).toContain("Run in terminal");
  });

  it("says a ready harness is installed and signed in, with nothing to run", () => {
    const html = render(
      summary({ status: "ready", version: "2.0.0", auth: "present", account: "a@b.c" }),
    );
    expect(text(html)).toContain("Ready");
    expect(text(html)).toContain("Installed · v2.0.0 · Signed in as a@b.c");
    expect(html).not.toContain("Run in terminal");
  });

  it("shows a failed probe's message", () => {
    const html = render(summary({ status: "error", installed: true, message: "out of credits" }));
    expect(text(html)).toContain("Error");
    expect(text(html)).toContain("out of credits");
    expect(html).not.toContain("Run in terminal");
  });

  it("draws the harness's logo for an iconKey that names one, else its monogram", () => {
    const logoPath = / d="([^"]*)"/.exec(renderToStaticMarkup(<LOGO_ICON />))?.[1] ?? "";
    const logo = render(summary({ status: "ready" }), false, LOGO_ICON_KEY);
    expect(logo).toContain(` d="${logoPath}"`);
    expect(logo).not.toContain(">Co<");
    expect(render(summary({ status: "ready" }), false, "terminal")).toContain(">Co<");
  });
});

import type { DetectedEditor } from "@poseidon/contracts/editors";
import { makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OpenInControl, OpenInSplitButton } from "@/components/open-in/open-in-control";
import { ClientRuntimeProvider } from "@/lib/client-runtime";
import { makeFixtureClient } from "@/lib/fixture-client";
import { installAppAtoms } from "@/state/app-runtime";

// The favourite is read from the app's settings; offline they never load, so
// the first detected editor leads.
installAppAtoms(null);

const cursor: DetectedEditor = {
  id: "cursor",
  label: "Cursor",
  kind: "editor",
  supportsLine: true,
};
const zed: DetectedEditor = { id: "zed", label: "Zed", kind: "editor", supportsLine: true };
const finder: DetectedEditor = {
  id: "finder",
  label: "Finder",
  kind: "file-manager",
  supportsLine: false,
};

const noop = () => {};

describe("OpenInSplitButton", () => {
  it("leads with the favourite, labelled for a wide header", () => {
    const html = renderToStaticMarkup(
      <OpenInSplitButton
        editors={[cursor, zed, finder]}
        favourite={zed}
        onOpen={noop}
        onPick={noop}
      />,
    );
    expect(html).toContain('aria-label="Open in Zed"');
    expect(html).toContain('<span class="hidden @lg/header:inline">Zed</span>');
    expect(html).toContain('aria-label="Open in…"');
    expect(html).not.toContain("Cursor");
  });
});

describe("OpenInControl", () => {
  it("leads with the first editor the server lists until a favourite is stored", () => {
    const html = renderToStaticMarkup(
      <ClientRuntimeProvider layer={makeFixtureClient().layer}>
        <OpenInControl projectId={makeProjectId()} threadId={makeThreadId()} />
      </ClientRuntimeProvider>,
    );
    expect(html).toContain('aria-label="Open in VS Code"');
  });
});

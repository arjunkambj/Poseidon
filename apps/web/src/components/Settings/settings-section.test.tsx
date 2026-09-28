import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsRow as FieldRow } from "@/components/Settings/schema-form";
import {
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "@/components/Settings/settings-section";

describe("SettingsPageHeader", () => {
  it("renders the title, description and actions", () => {
    const markup = renderToStaticMarkup(
      <SettingsPageHeader
        title="Keybindings"
        description="Every shortcut."
        actions={<button type="button">Reset</button>}
      />,
    );
    expect(markup).toContain("<h1");
    expect(markup).toContain("Keybindings");
    expect(markup).toContain("Every shortcut.");
    expect(markup).toContain("Reset</button>");
  });
});

describe("SettingsSection", () => {
  it("renders the title and description over a card whose rows get hairlines", () => {
    const markup = renderToStaticMarkup(
      <SettingsSection title="Alerts" description="When a thread changes.">
        <SettingsRow title="One" />
        <SettingsRow title="Two" />
      </SettingsSection>,
    );
    expect(markup).toMatch(/<h2[^>]*>Alerts<\/h2>/u);
    expect(markup).toContain("When a thread changes.");
    expect(markup).toContain('data-slot="card"');
    expect(markup).toMatch(/data-slot="card-content"[^>]*><div class="[^"]*divide-y/u);
    expect(markup.indexOf('data-slot="card"')).toBeLessThan(markup.indexOf("One"));
  });

  it("renders the children bare with card={false}", () => {
    const markup = renderToStaticMarkup(
      <SettingsSection title="Theme" card={false}>
        <p>previews</p>
      </SettingsSection>,
    );
    expect(markup).toContain("<p>previews</p>");
    expect(markup).not.toContain('data-slot="card"');
  });

  it("leaves out the heading when there is no title or description", () => {
    const markup = renderToStaticMarkup(
      <SettingsSection>
        <SettingsRow title="Only" />
      </SettingsSection>,
    );
    expect(markup).not.toContain("<h2");
    expect(markup).not.toContain("aria-labelledby");
  });

  it("names the section by its title", () => {
    const markup = renderToStaticMarkup(
      <SettingsSection title="Navigation">
        <ul />
      </SettingsSection>,
    );
    const labelledBy = /<section[^>]*aria-labelledby="([^"]+)"/u.exec(markup)?.[1];
    expect(labelledBy).toBeDefined();
    expect(markup).toContain(`<h2 id="${labelledBy}"`);
  });
});

describe("SettingsRow", () => {
  it("renders the title, description and control", () => {
    const markup = renderToStaticMarkup(
      <SettingsRow title="Sidebar" description="The left sidebar.">
        <button type="button">Bigger</button>
      </SettingsRow>,
    );
    expect(markup).toContain("Sidebar");
    expect(markup).toContain("The left sidebar.");
    expect(markup).toContain("Bigger</button>");
    expect(markup).not.toContain("<label");
  });

  it("labels the control when given htmlFor", () => {
    const markup = renderToStaticMarkup(
      <SettingsRow title="Play a sound" htmlFor="notifications-sound">
        <input id="notifications-sound" type="checkbox" />
      </SettingsRow>,
    );
    expect(markup).toMatch(/<label[^>]*for="notifications-sound"[^>]*>Play a sound<\/label>/u);
  });

  it("keeps the schema form's field row rendering its label and description", () => {
    const markup = renderToStaticMarkup(
      <FieldRow field={{ label: "Model", description: "What new threads use.", control: "select" }}>
        <span>control</span>
      </FieldRow>,
    );
    expect(markup).toContain("Model");
    expect(markup).toContain("What new threads use.");
    expect(markup).toContain("<span>control</span>");
  });
});

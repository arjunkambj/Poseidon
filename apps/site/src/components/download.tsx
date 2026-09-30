import { site } from "../site";

export const Download = () => (
  <section id="download" className="border-t border-border bg-header">
    <div className="mx-auto max-w-5xl px-6 py-20 text-center">
      <h2 className="text-3xl font-semibold tracking-tight text-strong">Download for macOS</h2>
      <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
        Packaged builds land with the M5 milestone. Until then, releases on GitHub carry the latest
        dmg and zip as soon as they exist.
      </p>
      <a
        href={site.downloadUrl}
        className="mt-8 inline-block rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-strong"
      >
        Get the latest release
      </a>
      <p className="mt-4 text-sm text-muted-foreground">
        Requires your own Claude Code, Codex or Command Code install and login.
      </p>
    </div>
  </section>
);

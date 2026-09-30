import { site } from "../site";

export const Hero = () => (
  <section id="top" className="mx-auto max-w-5xl px-6 pt-24 pb-16 text-center">
    <p className="mb-4 text-sm font-medium text-muted-foreground">
      Open source · macOS · Claude Code, Codex and Command Code
    </p>
    <h1 className="text-5xl font-semibold tracking-tight text-strong sm:text-6xl">
      A desktop home for
      <br />
      Claude Code and Codex.
    </h1>
    <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
      {site.name} turns agent sessions into real project work: threads bound to your repos, a full
      timeline of every turn, approvals you control, per-turn checkpoints and a built-in browser —
      all in one native window. It runs Claude Code by default, Codex when Claude Code is missing,
      and Command Code when you pick it.
    </p>
    <div className="mt-10 flex items-center justify-center gap-4">
      <a
        href={site.downloadUrl}
        className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-strong"
      >
        Download for macOS
      </a>
      <a
        href={site.repoUrl}
        className="rounded-md border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-hover"
      >
        View on GitHub
      </a>
    </div>
  </section>
);

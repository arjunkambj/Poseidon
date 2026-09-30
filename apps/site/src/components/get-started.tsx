import { site } from "../site";

const steps = [
  {
    title: "Install Claude Code",
    body: "Poseidon drives your own Claude Code, Codex or Command Code install — it never ships or bundles a harness. Without Claude Code, new threads run on Codex.",
    code: "npm i -g @anthropic-ai/claude-code && claude",
  },
  {
    title: "Download Poseidon",
    body: "Grab the signed dmg for macOS. Windows and Linux builds follow the MVP.",
    code: null,
  },
  {
    title: "Open a project",
    body: "Point Poseidon at any local git repo, start a thread, and watch every turn land on the timeline.",
    code: null,
  },
] as const;

export const GetStarted = () => (
  <section id="get-started" className="mx-auto max-w-5xl px-6 py-20">
    <h2 className="text-3xl font-semibold tracking-tight text-strong">Get started</h2>
    <p className="mt-3 max-w-2xl text-muted-foreground">
      Three steps from zero to a running agent session. The full docs — architecture, contracts and
      decisions — live in the repository.
    </p>
    <ol className="mt-10 grid gap-6 sm:grid-cols-3">
      {steps.map((step, index) => (
        <li key={step.title} className="rounded-lg border border-border bg-card px-5 py-4">
          <div className="text-sm font-medium text-muted-foreground">Step {index + 1}</div>
          <h3 className="mt-1 font-medium text-strong">{step.title}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{step.body}</p>
          {step.code === null ? null : (
            <code className="mt-3 block rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
              {step.code}
            </code>
          )}
        </li>
      ))}
    </ol>
    <a
      href={site.docsUrl}
      className="mt-8 inline-block text-sm font-medium text-foreground underline underline-offset-4 hover:text-strong"
    >
      Read the docs on GitHub
    </a>
  </section>
);

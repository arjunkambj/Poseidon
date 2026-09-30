const features = [
  {
    title: "Threads per project",
    body: "Every conversation is bound to a git repo and a resumable session. Close the app, crash mid-turn, come back — the thread is where you left it.",
  },
  {
    title: "A full timeline",
    body: "Assistant text, reasoning, shell commands, file edits, MCP tool calls, subagent tasks, plans and errors — every turn rendered, nothing hidden.",
  },
  {
    title: "Approvals you control",
    body: "Allow once, allow for the session, or allow always by pattern. Plan mode with accept and revise. Interrupt any turn at any time.",
  },
  {
    title: "Checkpoints and diffs",
    body: "Each turn writes a hidden git ref. Diff the working tree or any two turns, and restore a checkpoint when a turn went sideways.",
  },
  {
    title: "A browser the agent can drive",
    body: "An in-app preview pane exposed to the agent through MCP tools — with a human-interrupt rule so you always keep the wheel.",
  },
  {
    title: "Your models, your effort",
    body: "Pick the harness, model and effort level per thread from Claude Code, Codex or Command Code. Approval-required, auto-accept or full-access runtime modes.",
  },
] as const;

export const Features = () => (
  <section id="features" className="border-t border-border bg-header">
    <div className="mx-auto max-w-5xl px-6 py-20">
      <h2 className="text-3xl font-semibold tracking-tight text-strong">
        Built for real sessions, not demos
      </h2>
      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <div
            key={feature.title}
            className="rounded-lg border border-border bg-card px-5 py-4 text-card-foreground"
          >
            <h3 className="font-medium text-strong">{feature.title}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{feature.body}</p>
          </div>
        ))}
      </div>
    </div>
  </section>
);

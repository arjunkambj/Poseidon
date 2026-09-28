/**
 * The probe: the model-list parser against the REAL recorded table, and
 * `probe()` against real binaries that answer the way the CLI's exit codes say.
 *
 * `parseModelList` is the sole data source for the whole model picker, and the
 * table it reads is `fixtures/cmd/probe/list-models.stdout.txt` — a real
 * `cmd --list-models` captured from command-code 1.55.1 on 2026-09-18, not a
 * reconstruction. The old hand-written fixture hid three bugs this file now
 * pins: bare ids (`claude-opus-5`, `gpt-6-astra`) were dropped as headers,
 * `:free`-tagged ids were truncated, and the table's own chrome was parsed as
 * a model.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { NPX_PACKAGE, resolveBinary } from "./binary";
import { EXIT_MESSAGES } from "./exitCodes";
import {
  CMD_ACCOUNT_HELP_URL,
  CMD_INSTALL_COMMAND,
  CMD_LOGIN_SUBCOMMAND,
  isBelowOldestTested,
  OLDEST_TESTED_VERSION,
  parseModelList,
  PREFERRED_DEFAULT_MODEL,
  probe,
  withPreferredFirst,
} from "./probe";

const FIXTURE = NodePath.resolve(
  NodeURL.fileURLToPath(import.meta.url),
  "../../../testkit/fixtures/cmd/probe/list-models.stdout.txt",
);

const listModels = NodeFS.readFileSync(FIXTURE, "utf8");

/**
 * The last line of a real run this machine made after the account ran out —
 * the harness's own wording, so the test cannot drift from what it prints.
 */
const recordedCreditsError = NodeFS.readFileSync(
  NodePath.resolve(
    NodeURL.fileURLToPath(import.meta.url),
    "../../../testkit/fixtures/cmd/probe-insufficient-credits.ndjson",
  ),
  "utf8",
)
  .trimEnd()
  .split("\n")
  .at(-1)!;

/** The real `cmd --help` from 1.55.1: where the login subcommand is named. */
const recordedHelp = NodeFS.readFileSync(
  NodePath.resolve(
    NodeURL.fileURLToPath(import.meta.url),
    "../../../testkit/fixtures/cmd/probe/help.stdout.txt",
  ),
  "utf8",
);

describe("parseModelList", () => {
  const models = parseModelList(listModels);

  it("reads every model the CLI lists, including the bare-id families", () => {
    // The table's own header says how many there should be.
    expect(listModels).toContain("70 models");
    expect(models).toHaveLength(70);
    // Anthropic and OpenAI ids carry no `provider/` prefix; the old parser
    // swallowed all sixteen of them as section headers.
    expect(models.map((model) => model.id)).toContain("claude-opus-5");
    expect(models.map((model) => model.id)).toContain("gpt-6-astra");
    expect(models.find((model) => model.id === "claude-opus-5")?.family).toBe("Anthropic");
    expect(models.find((model) => model.id === "gpt-5.3-codex")?.family).toBe("OpenAI");
    expect(models.find((model) => model.id === "google/gemini-3.8-flash")?.family).toBe("Google");
    expect(models.find((model) => model.id === "deepseek/deepseek-v4-pro")?.family).toBe(
      "Open Source",
    );
  });

  it("keeps a :free tag as part of the id", () => {
    const longcat = models.find((model) => model.id.startsWith("meituan/longcat-2.0"));
    // Truncating the tag would hand `--model` an id the CLI rejects.
    expect(longcat?.id).toBe("meituan/longcat-2.0:free");
    expect(longcat?.free).toBe(true);
    expect(longcat?.label).toBe("LongCat 2.0 (Free)");
    expect(longcat?.description).toBe("trillion-parameter agentic coding with 1M context");
  });

  it("never parses the table's chrome as a model", () => {
    const ids = models.map((model) => model.id);
    expect(ids).not.toContain("Docs:");
    expect(ids).not.toContain("Available");
    expect(ids).not.toContain("cmd");
    expect(models.every((model) => !model.id.includes(" "))).toBe(true);
  });

  it("strips the (default), (recommended) and FREE markers out of the description", () => {
    const flash = models.find((model) => model.id === "deepseek/deepseek-v4-flash");
    expect(flash?.label).toBe("DeepSeek V4 Flash");
    expect(flash?.description).toBe("fast hybrid-attention reasoning");
    const sonnet = models.find((model) => model.id === "claude-sonnet-5");
    expect(sonnet?.label).toBe("Claude Sonnet 5");
    expect(sonnet?.description).toBe("best combo of speed & intelligence");
    const sante = models.find((model) => model.id === "inclusionai/ling-3.0-flash-sante:free");
    expect(sante?.free).toBe(true);
    expect(sante?.label).toBe("Ling 3.0 Flash Sante (Free)");
    expect(sante?.description).toBe(
      "health & medicine tuned lightweight-MoE, still strong on code",
    );
  });

  it("names every model from its id and never from its tagline", () => {
    // The owner's report: the second column ("Muse Spark 1.2 at ~95% off")
    // was shown as the model's name. The table has no name column at all.
    const muse = models.find((model) => model.id === "meta/muse-spark-1.2-contributor");
    expect(muse?.label).toBe("Muse Spark 1.2 Contributor");
    expect(muse?.description).toBe("Muse Spark 1.2 at ~95% off");
    expect(models.find((model) => model.id === "google/gemini-3.5-flash")?.label).toBe(
      "Gemini 3.5 Flash",
    );
    expect(models.find((model) => model.id === "xai/grok-4.5")?.label).toBe("Grok 4.5");
    expect(models.every((model) => model.label !== model.description)).toBe(true);
    expect(models.every((model) => model.description !== undefined)).toBe(true);
    expect(new Set(models.map((model) => model.label)).size).toBe(models.length);
  });

  it("flags the models whose description mentions vision or multimodality", () => {
    expect(models.find((model) => model.id === "moonshotai/kimi-k2.6")?.vision).toBe(true);
    expect(models.find((model) => model.id === "deepseek/deepseek-v4-pro")?.vision).toBeUndefined();
  });

  it("puts the preferred default first when the table lists it, and only then", () => {
    const ordered = withPreferredFirst(models);
    expect(ordered[0]?.id).toBe(PREFERRED_DEFAULT_MODEL);
    expect(ordered).toHaveLength(models.length);
    const without = models.filter((model) => model.id !== PREFERRED_DEFAULT_MODEL);
    expect(withPreferredFirst(without)).toEqual(without);
  });

  it("narrows nothing when the table prints no effort ladder", () => {
    // 1.55.1 prints no [low,medium] markers on any of its 70 rows. Assuming
    // low/medium/high was inventing a ladder: every recorded
    // `model_request_end` on the account default reports `"effort":"xhigh"`,
    // and `--effort xhigh` is accepted — so the picker hid two rungs the CLI
    // uses by default and picking "high" silently downgraded the run.
    expect(models.every((model) => model.efforts.length === 5)).toBe(true);
    expect(models[0]?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const rungs = new Set(models.flatMap((model) => [...model.efforts]));
    expect(rungs.has("xhigh")).toBe(true);
    expect(rungs.has("max")).toBe(true);
  });

  it("still honours a ladder the table does print", () => {
    expect(parseModelList("acme/model-x  fast one [low,high]")[0]?.efforts).toEqual([
      "low",
      "high",
    ]);
  });

  it("names a bare id, leaves its description out, and survives an empty output", () => {
    // No `description: ""`: the contract rejects an empty one, and one bad row
    // would fail decoding of the whole list.
    expect(parseModelList("acme/model-x")).toEqual([
      {
        id: "acme/model-x",
        label: "Model X",
        family: "acme",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
    ]);
    expect(parseModelList("")).toEqual([]);
    expect(parseModelList("\n\n  \n")).toEqual([]);
  });
});

describe("parseModelList on the 1.66.0 table", () => {
  // A real `cmd --no-auto-update --list-models` from command-code 1.66.0.
  const table = NodeFS.readFileSync(
    NodePath.resolve(
      NodeURL.fileURLToPath(import.meta.url),
      "../../../testkit/fixtures/cmd/probe-list-models-1.66.0.stdout.txt",
    ),
    "utf8",
  );
  const models = parseModelList(table);

  it("reads the 82 counted models plus the decision model, Stealth included", () => {
    // The header counts the 82 coding models; the headless-only decision
    // model below the footer is not in that count.
    expect(table).toContain("82 models");
    expect(models).toHaveLength(83);
    expect(models.filter((model) => model.hidden !== true)).toHaveLength(82);
    const bunny = models.find((model) => model.id === "stealth/space-bunny-alpha");
    expect(bunny?.family).toBe("Stealth");
    expect(bunny?.label).toBe("Space Bunny Alpha");
    expect(bunny?.free).toBe(true);
    expect(bunny?.description).toBe("stealth model with 1M context");
  });

  it("hides the headless-only decision model and nothing else", () => {
    const jev = models.find((model) => model.id === "typesafe/jev");
    expect(jev?.hidden).toBe(true);
    expect(jev?.family).toBe("Decision models (headless only)");
    expect(models.filter((model) => model.hidden === true)).toHaveLength(1);
  });

  it("gives every model a unique name that is not its tagline", () => {
    expect(new Set(models.map((model) => model.label)).size).toBe(models.length);
    expect(models.every((model) => model.label !== model.description)).toBe(true);
    expect(models.find((model) => model.id === "claude-opus-5-5")?.label).toBe("Claude Opus 5.5");
    expect(models.find((model) => model.id === "meituan/longcat-2.0")?.label).toBe("LongCat 2.0");
  });
});

// ── probe() against real child processes ───────────────────────

interface Fake {
  readonly dir: string;
  /** Writes a `cmd` stand-in with the given body and returns its path. */
  readonly binary: (body: string) => string;
}

const fakes = (): Effect.Effect<Fake, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync((): Fake => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-probe-test-"));
      let counter = 0;
      return {
        dir,
        binary: (body) => {
          counter += 1;
          const path = NodePath.join(dir, `cmd-${counter}.mjs`);
          NodeFS.writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
          return path;
        },
      };
    }),
    (fake) => Effect.sync(() => NodeFS.rmSync(fake.dir, { recursive: true, force: true })),
  );

/** A stand-in whose `status --json` behaviour the test dictates. */
const statusBinary = (status: string, exitCode = 0, models = ""): string => `
const argv = process.argv.slice(2);
if (argv.includes("--list-models")) {
  process.stdout.write(${JSON.stringify(models)});
  process.exit(${models === "" ? 1 : 0});
}
process.stdout.write(${JSON.stringify(status)});
process.exit(${exitCode});
`;

describe("probe", () => {
  it.effect("reports ready with the account, version and models", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const binaryPath = fake.binary(
        statusBinary(
          JSON.stringify({ authenticated: true, version: "1.54.0", user: "someone" }),
          0,
          "acme/one  One\n",
        ),
      );

      const result = yield* probe({ binaryPath });
      expect(result.status).toBe("ready");
      expect(result.auth).toBe("present");
      expect(result.account).toBe("someone");
      expect(result.version).toBe("1.54.0");
      expect(result.binaryPath).toBe(binaryPath);
      expect(result.installed).toBe(true);
      // Signed in: there is nothing to run, so no command is offered.
      expect(result.loginCommand).toBeUndefined();
      expect(result.models.map((model) => model.id)).toEqual(["acme/one"]);
      expect(result.warnings).toEqual([]);
    }),
  );

  it.effect("reports not-authenticated on exit 3 without even reading stdout", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const binaryPath = fake.binary(statusBinary("not json", 3));
      const result = yield* probe({ binaryPath });
      expect(result.status).toBe("not-authenticated");
      expect(result.auth).toBe("absent");
      // Found and ran, only signed out.
      expect(result.installed).toBe(true);
      // Spelled against the configured binary, not the bare `cmd`.
      expect(result.loginCommand).toBe(`${binaryPath} ${CMD_LOGIN_SUBCOMMAND}`);
      expect(result.message).toContain(`\`${binaryPath} ${CMD_LOGIN_SUBCOMMAND}\``);
      // The subcommand is the one the CLI's own help lists and its exit-3
      // message names, not one we made up.
      expect(recordedHelp).toMatch(new RegExp(`^\\s+cmd ${CMD_LOGIN_SUBCOMMAND}\\s{2,}Login`, "m"));
      expect(EXIT_MESSAGES[3]!.message).toContain(`\`cmd ${CMD_LOGIN_SUBCOMMAND}\``);
      // No recording names an install command, so none is offered.
      expect(result.installCommand).toBeUndefined();
      // Exit 3 short-circuits: no point listing models for a logged-out CLI.
      expect(result.models).toEqual([]);
    }),
  );

  it.effect("reports not-authenticated when the status json says so", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const binaryPath = fake.binary(
        statusBinary(JSON.stringify({ authenticated: false, version: "1.54.0" }), 0, "a/b\n"),
      );
      const result = yield* probe({ binaryPath });
      expect(result.status).toBe("not-authenticated");
      expect(result.auth).toBe("absent");
      expect(result.installed).toBe(true);
      expect(result.loginCommand).toBe(`${binaryPath} ${CMD_LOGIN_SUBCOMMAND}`);
      // The model list still came back, so the picker has something to show.
      expect(result.models).toHaveLength(1);
    }),
  );

  it.effect("tells an npx-fallback user to sign in through npx, not a cmd they lack", () =>
    Effect.gen(function* () {
      // The first-run machine: node installed, no global `cmd`, signed out.
      // npm exec passes the child's exit 3 straight through.
      const fake = yield* fakes();
      NodeFS.writeFileSync(
        NodePath.join(fake.dir, "npx"),
        `#!/usr/bin/env node\n${statusBinary("", 3)}\n`,
        {
          mode: 0o755,
        },
      );
      const result = yield* probe({}, (config) => resolveBinary(config, { PATH: fake.dir }, []));
      expect(result.status).toBe("not-authenticated");
      expect(result.binaryPath).toBe(`npx ${NPX_PACKAGE}`);
      expect(result.loginCommand).toBe(`npx -y ${NPX_PACKAGE} ${CMD_LOGIN_SUBCOMMAND}`);
      expect(result.message).toContain(`\`npx -y ${NPX_PACKAGE} ${CMD_LOGIN_SUBCOMMAND}\``);
    }),
  );

  /**
   * The version policy in one table: nothing is pinned, so only a binary
   * *older* than the oldest release we have recordings for is worth a word.
   * 1.55.1 is what is installed today and 1.54.0 is the floor — neither warns,
   * and neither does whatever ships next.
   */
  it("warns below the oldest tested version and nowhere else", () => {
    expect(OLDEST_TESTED_VERSION).toBe("1.54.0");
    expect(isBelowOldestTested("1.53.9")).toBe(true);
    expect(isBelowOldestTested("0.9.0")).toBe(true);
    expect(isBelowOldestTested("1.54.0")).toBe(false); // equal
    expect(isBelowOldestTested("1.55.1")).toBe(false); // installed today
    expect(isBelowOldestTested("2.0.0")).toBe(false); // whatever comes next
    // Unparseable is not old: refusing a build whose version string we cannot
    // read would be the pin this connector deliberately does not have.
    expect(isBelowOldestTested("nightly")).toBe(false);
    expect(isBelowOldestTested("")).toBe(false);
  });

  it.effect("carries that warning on the probe, and says nothing for a newer cmd", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const old = yield* probe({
        binaryPath: fake.binary(
          statusBinary(JSON.stringify({ authenticated: true, version: "1.53.9" }), 0, "a/b\n"),
        ),
      });
      expect(old.status).toBe("ready");
      expect(old.warnings.join(" ")).toContain("1.53.9");
      expect(old.warnings.join(" ")).toContain(OLDEST_TESTED_VERSION);

      // The version the operator actually has installed.
      const installed = yield* probe({
        binaryPath: fake.binary(
          statusBinary(JSON.stringify({ authenticated: true, version: "1.55.1" }), 0, "a/b\n"),
        ),
      });
      expect(installed.warnings).toEqual([]);

      const newer = yield* probe({
        binaryPath: fake.binary(
          statusBinary(JSON.stringify({ authenticated: true, version: "2.0.0" }), 0, "a/b\n"),
        ),
      });
      expect(newer.warnings).toEqual([]);
    }),
  );

  it.effect(
    "treats a running binary with unreadable status as ready, and warns on a bad model list",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakes();
        const result = yield* probe({
          binaryPath: fake.binary(statusBinary("not json at all", 0)),
        });
        // A binary that runs and exits 0 is working even if we cannot read it.
        expect(result.status).toBe("ready");
        expect(result.version).toBeUndefined();
        expect(result.models).toEqual([]);
        expect(result.warnings).toEqual([]);
      }),
  );

  it.effect("reports error when status fails for a reason it cannot name", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const result = yield* probe({
        binaryPath: fake.binary(`
process.stderr.write("something broke");
process.exit(42);
`),
      });
      expect(result.status).toBe("error");
      expect(result.auth).toBe("unknown");
      expect(result.installed).toBe(true);
      expect(result.message).toContain("something broke");
      expect(result.message).toContain("42");
    }),
  );

  it.effect("names a known exit code, and keeps the harness's own words", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const result = yield* probe({
        binaryPath: fake.binary(`
process.stderr.write("429 Too Many Requests");
process.exit(5);
`),
      });
      // "status exited 5" told the user nothing they could act on.
      expect(result.message).toBe(`${EXIT_MESSAGES[5]!.message} (429 Too Many Requests)`);
    }),
  );

  it.effect("sends an out-of-credits account to the billing page", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      // What the real CLI printed when this machine's account ran out, taken
      // from the recording rather than invented.
      const result = yield* probe({
        binaryPath: fake.binary(`
process.stderr.write(${JSON.stringify(recordedCreditsError)} + "\\n");
process.exit(10);
`),
      });
      expect(result.status).toBe("error");
      // Not "unknown": the login is fine, the balance is not — and the welcome
      // flow needs the difference to be able to offer a way forward.
      expect(result.auth).toBe("present");
      expect(result.helpUrl).toBe(CMD_ACCOUNT_HELP_URL);
      // The link is the one the CLI's own message names, not one we made up.
      expect(recordedCreditsError).toContain(CMD_ACCOUNT_HELP_URL);
      expect(result.message).toBe(EXIT_MESSAGES[10]!.message);
      expect(recordedCreditsError).toContain("insufficient credits");
    }),
  );

  it.effect("says not installed, with the install line, when nothing resolves", () =>
    Effect.gen(function* () {
      const result = yield* probe({}, () => null);
      expect(result).toMatchObject({
        status: "not-installed",
        installed: false,
        installCommand: CMD_INSTALL_COMMAND,
        auth: "unknown",
        models: [],
      });
      expect(result.loginCommand).toBeUndefined();
      // The install names the same package the npx fallback runs.
      expect(CMD_INSTALL_COMMAND).toBe(`npm install -g ${NPX_PACKAGE.replace(/@latest$/, "")}`);
    }),
  );

  it.effect("fails with ProbeFailed when the configured binary is not there", () =>
    Effect.gen(function* () {
      const error = yield* probe({ binaryPath: "/nonexistent/cmd-xyz" }).pipe(Effect.flip);
      expect(error._tag).toBe("ProbeFailed");
      expect(error.kind).toBe("cmd");
    }),
  );

  it.effect("runs the probe through the env leak guard", () =>
    Effect.gen(function* () {
      const fake = yield* fakes();
      const binaryPath = fake.binary(`
process.stdout.write(JSON.stringify({
  authenticated: true,
  version: "1.54.0",
  user: [
    process.env.ANTHROPIC_API_KEY ?? "-",
    process.env.POSEIDON_SERVER_SECRET ?? "-",
    process.env.COMMAND_CODE_API_KEY ?? "-",
  ].join("|"),
}));
process.exit(0);
`);
      const previous = { ...process.env };
      process.env.ANTHROPIC_API_KEY = "leaked";
      process.env.POSEIDON_SERVER_SECRET = "leaked";
      try {
        const result = yield* probe({
          binaryPath,
          extraEnv: { COMMAND_CODE_API_KEY: "from-config" },
        });
        // Foreign credentials and control-plane variables are stripped; the
        // operator's own extraEnv reaches the probe, so an API key configured
        // there is not reported as "not authenticated".
        expect(result.account).toBe("-|-|from-config");
      } finally {
        process.env = previous;
      }
    }),
  );
});

/**
 * Every recording's argv, checked against the argv `buildArgs` produces today.
 *
 * `fixtures/cmd/README.md` promises that each run "was spawned with exactly the
 * argv and environment `spawn.ts` builds". Nothing enforced it, and it drifted:
 * `--tools-enable ask_user_question` joined every turn while only one recording
 * carried it, and `--yolo` joined every turn while three recordings did not.
 * That is how "a hook deny is honoured under --yolo" came to be claimed by two
 * recordings taken without `--yolo`, where the CLI would have refused the call
 * on its own.
 *
 * So this reads each manifest's recorded argv back into a `buildArgs` input,
 * rebuilds it, and insists on getting the same list — which fails the moment a
 * flag's order, spelling or presence changes on either side.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import type { Effort } from "@poseidon/contracts/enums";

import { generateTextArgs } from "./generateText";
import { buildArgs, TOOLS_ENABLED, type BuildArgsInput } from "./spawn";

const RECORDINGS = NodePath.resolve(
  NodeURL.fileURLToPath(import.meta.url),
  "../../../testkit/fixtures/cmd",
);

interface ManifestTurn {
  readonly index: number;
  readonly connectorArgs: ReadonlyArray<string>;
}

const manifests = (): ReadonlyArray<{ scenario: string; turns: ReadonlyArray<ManifestTurn> }> =>
  NodeFS.readdirSync(RECORDINGS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "probe")
    .map((entry) => entry.name)
    .sort()
    .map((scenario) => ({
      scenario,
      ...(JSON.parse(
        NodeFS.readFileSync(NodePath.join(RECORDINGS, scenario, "manifest.json"), "utf8"),
      ) as { turns: ReadonlyArray<ManifestTurn> }),
    }));

/**
 * `--yolo` is the flag that changes what the CLI itself will allow, so a
 * recording without it describes a different gate from the one the connector
 * runs under. These are the recordings that deliberately lack it, and what each
 * one is the counter-example to — they are evidence for why the connector sends
 * it, so they are kept rather than re-recorded, and named here so the list
 * cannot grow by accident.
 */
const NO_YOLO: Readonly<Record<string, string>> = {
  "plan-no-yolo":
    "plan mode without --yolo — the argv a plan turn is spawned with today: print mode refuses the write, which is what makes the mode read-only",
  "shell-allow": "a hook allow without --yolo: print mode refuses the call anyway",
  "shell-deny": "a hook deny without --yolo, where the CLI would have refused it regardless",
};

/**
 * Recordings of `generateText`'s one-shot call rather than of a turn. That
 * argv never carries `--yolo` — its absence is what keeps the call read-only —
 * so they are held to `generateTextArgs` instead.
 */
const ONE_SHOT = new Set(["generate-text", "generate-text-effort"]);

/**
 * Flags the connector adds to every turn that a recording is allowed to
 * predate, each with the reason its absence costs that recording nothing. A
 * flag not listed here has to be in every recording's argv.
 *
 * `--tools-enable ask_user_question` un-withholds one tool and changes nothing
 * else about a run; `question/` and `question-tools/` are the pair that record
 * both sides of it, and re-recording the other fifteen would only spend the
 * operator's plan to change nothing they are cited for.
 */
const TOLERATED: Readonly<Record<string, string>> = {
  "--tools-enable ask_user_question":
    "un-withholds one tool; question/ and question-tools/ record both sides of it",
};

/** Flags `buildArgs` knows nothing about; a scenario appends them itself. */
const FOREIGN_FLAGS = new Set(["--tools-all"]);

interface Parsed {
  readonly input: BuildArgsInput;
  /** Trailing flags no `buildArgs` input can produce. */
  readonly foreign: ReadonlyArray<string>;
}

/** Reads a recorded argv back into the input that would produce it. */
const parse = (argv: ReadonlyArray<string>): Parsed => {
  expect(argv[0]).toBe("-p");
  const input: {
    -readonly [K in keyof BuildArgsInput]: BuildArgsInput[K];
  } = { prompt: argv[1] ?? "" };
  const addDir: Array<string> = [];
  const toolsEnable: Array<string> = [];
  const foreign: Array<string> = [];
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = (): string => {
      i += 1;
      return argv[i] ?? "";
    };
    switch (flag) {
      case "--output-format":
      case "--verbose":
      case "-t":
      case "--skip-onboarding":
      case "--no-auto-update":
        // The fixed prefix; `buildArgs` emits it unconditionally.
        if (flag === "--output-format") next();
        break;
      case "--no-session":
        input.noSession = true;
        break;
      case "--session":
        input.sessionId = next();
        break;
      case "--fork-session":
        input.forkSession = true;
        break;
      case "--model":
        input.model = next();
        break;
      case "--effort":
        input.effort = next();
        break;
      case "--permission-mode":
        input.permissionMode = next() as BuildArgsInput["permissionMode"];
        break;
      case "--yolo":
        input.yolo = true;
        break;
      case "--max-turns":
        input.maxTurns = Number(next());
        break;
      case "--add-dir":
        addDir.push(next());
        break;
      case "--tools-enable":
        toolsEnable.push(next());
        break;
      default:
        expect(FOREIGN_FLAGS.has(flag ?? ""), `unrecognised flag ${String(flag)}`).toBe(true);
        foreign.push(flag ?? "");
        break;
    }
  }
  if (addDir.length > 0) input.addDir = addDir;
  if (toolsEnable.length > 0) input.toolsEnable = toolsEnable;
  return { input, foreign };
};

describe("the argv every recording was made with", () => {
  it("is argv buildArgs still produces, flag for flag and in order", () => {
    for (const manifest of manifests()) {
      for (const turn of manifest.turns) {
        const { input, foreign } = parse(turn.connectorArgs);
        expect(
          [...buildArgs(input), ...foreign],
          `${manifest.scenario} turn ${turn.index}`,
        ).toEqual([...turn.connectorArgs]);
      }
    }
  });

  /**
   * `--yolo` is on every ordinary turn the connector spawns, and it is what
   * decides whether the CLI refuses a write or a shell call on its own. A
   * recording without it that is not a named counter-example is describing a
   * gate nobody runs. Plan turns are the exception and `turnArgs.test.ts` is
   * where that is asserted.
   */
  it("carries --yolo, or is a named counter-example to it", () => {
    const missing: Array<string> = [];
    for (const manifest of manifests()) {
      for (const turn of manifest.turns) {
        if (
          !turn.connectorArgs.includes("--yolo") &&
          NO_YOLO[manifest.scenario] === undefined &&
          !ONE_SHOT.has(manifest.scenario)
        ) {
          missing.push(`${manifest.scenario} turn ${turn.index}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("holds each one-shot recording to generateTextArgs, which sends no --yolo", () => {
    const oneShots = manifests().filter((manifest) => ONE_SHOT.has(manifest.scenario));
    expect(oneShots.map((manifest) => manifest.scenario).sort()).toEqual([...ONE_SHOT].sort());
    for (const manifest of oneShots) {
      for (const turn of manifest.turns) {
        const { input } = parse(turn.connectorArgs);
        const rebuilt = generateTextArgs({
          prompt: input.prompt,
          model: input.model ?? "",
          ...(input.effort === undefined ? {} : { effort: input.effort as Effort }),
        });
        expect(rebuilt, manifest.scenario).toEqual([...turn.connectorArgs]);
        expect(rebuilt).not.toContain("--yolo");
      }
    }
  });

  it("names a --yolo counter-example that really is one", () => {
    for (const [scenario, why] of Object.entries(NO_YOLO)) {
      const found = manifests().filter((manifest) => manifest.scenario === scenario);
      expect(found, `${scenario} is listed but not recorded`).toHaveLength(1);
      expect(why.length).toBeGreaterThan(20);
      // A recording that has caught up with the connector's argv is no longer
      // a counter-example and must come off this list.
      expect(
        found[0]!.turns.some((turn) => !turn.connectorArgs.includes("--yolo")),
        `${scenario} now carries --yolo — drop it from the list`,
      ).toBe(true);
      // And the entry says which of the two it is, so the list cannot quietly
      // keep describing a gate the connector has changed its mind about.
      expect(why).toMatch(/plan mode|print mode|hook/);
    }
  });

  /**
   * Everything else the connector always sends. Absences are allowed only where
   * `TOLERATED` says why, so the next flag to join `buildArgs` fails here until
   * somebody either re-records or writes down what the gap costs.
   */
  it("carries every other always-on flag, or says why the gap is harmless", () => {
    const always = TOOLS_ENABLED.map((tool) => `--tools-enable ${tool}`);
    const unexplained: Array<string> = [];
    for (const manifest of manifests()) {
      for (const turn of manifest.turns) {
        const argv = turn.connectorArgs.join(" ");
        for (const flag of always) {
          if (!argv.includes(flag) && TOLERATED[flag] === undefined) {
            unexplained.push(`${manifest.scenario} turn ${turn.index}: ${flag}`);
          }
        }
      }
    }
    expect(unexplained).toEqual([]);
    // And nothing is excused that the connector has stopped sending.
    for (const flag of Object.keys(TOLERATED)) {
      expect(always, `${flag} is excused but no longer built`).toContain(flag);
    }
  });
});

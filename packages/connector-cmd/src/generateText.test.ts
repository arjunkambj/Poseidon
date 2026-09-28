/**
 * `generateText` against real one-shot recordings, through the connector's own
 * definition and a real spawned process.
 *
 * `fixtures/cmd/generate-text/` is the CLI answering the one-shot argv on
 * `poolside/laguna-s-2.1-free`; `generate-text-effort/` is the same call with
 * `--effort low` on that model, which takes none, refused by the CLI before
 * any request; `generate-text-effort-retry/` is that refusal followed by the
 * same call without `--effort`, answered; `max-turns/` is a run stopped at its
 * turn cap, exit 8. The
 * replayer logs each argv and cwd it was handed, which is how the argv and the
 * temporary directory are checked.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import type { ConnectorServices, GenerateTextInput } from "@poseidon/connector-sdk/definition";
import { makeConnectorInstanceId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";

import { cmdConnectorDefinition } from "./definition";
import {
  answerOf,
  fitArgument,
  generateTextArgs,
  refusedEffort,
  removeLeftovers,
} from "./generateText";

const TESTKIT = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../../../testkit");
const REPLAY_BINARY = NodePath.join(TESTKIT, "bin", "replay-cmd.mjs");
const RECORDINGS = NodePath.join(TESTKIT, "fixtures", "cmd");

interface RecordedTurn {
  readonly connectorArgs: ReadonlyArray<string>;
  readonly sessionId: string | null;
  readonly exitCode: number;
  readonly transcriptPath: string | null;
  readonly projectDirListing: ReadonlyArray<string>;
  readonly files: { readonly stdout: string; readonly stderr: string };
}

const manifestOf = (scenario: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(RECORDINGS, scenario, "manifest.json"), "utf8")) as {
    readonly model: string;
    readonly turns: ReadonlyArray<RecordedTurn>;
  };

const recorded = (scenario: string, name: string): string =>
  NodeFS.readFileSync(NodePath.join(RECORDINGS, scenario, name), "utf8");

/** The call the recording was made with: `system`, a blank line, then `prompt`. */
const inputOf = (scenario: string): GenerateTextInput => {
  const manifest = manifestOf(scenario);
  const [system, ...rest] = (manifest.turns[0]?.connectorArgs[1] ?? "").split("\n\n");
  return { system: system ?? "", prompt: rest.join("\n\n"), model: manifest.model };
};

const services = (): Effect.Effect<ConnectorServices> =>
  Effect.clockWith((clock) =>
    Effect.succeed<ConnectorServices>({
      mcpEndpoint: () => Effect.succeed({ url: "", bearer: "" }),
      hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:9/hooks", bearer: "t" }),
      permissions: { decide: () => Effect.succeed("allow" as const) },
      attachmentsDir: NodePath.join(NodeOS.tmpdir(), "cmd-generate-attachments"),
      logger: { log: () => Effect.void },
      clock,
    }),
  );

/**
 * A temp home and argv log, and an instance whose binary replays `scenario`:
 * its first turn on every spawn, or each spawn the next turn when `inTurn` is
 * false.
 */
const replaying = (scenario: string, inTurn = true) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-generate-"))),
      (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
    );
    const home = NodePath.join(root, "home");
    const argvLog = NodePath.join(root, "argv.ndjson");
    NodeFS.mkdirSync(home, { recursive: true });
    const instance = yield* cmdConnectorDefinition.createInstance({
      instanceId: makeConnectorInstanceId(),
      config: {
        binaryPath: REPLAY_BINARY,
        extraEnv: {
          HOME: home,
          POSEIDON_REPLAY_DIR: NodePath.join(RECORDINGS, scenario),
          ...(inTurn
            ? { POSEIDON_REPLAY_TURN: "0" }
            : { POSEIDON_REPLAY_STATE: NodePath.join(root, "replay-state") }),
          POSEIDON_REPLAY_ARGV_LOG: argvLog,
        },
      },
      services: yield* services(),
    });
    const invocations = () =>
      NodeFS.readFileSync(argvLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { argv: ReadonlyArray<string>; cwd: string });
    return { instance, home, invocations };
  });

describe("generateText on the recorded one-shot", () => {
  it.live("answers the result line's text", () =>
    Effect.gen(function* () {
      const { instance } = yield* replaying("generate-text");
      expect(instance.capabilities.textGeneration).toBe(true);
      const text = yield* instance.generateText!(inputOf("generate-text"));
      expect(text).toBe("Fix typo in README install section");
    }).pipe(Effect.scoped),
  );

  it.live("hands the CLI the recorded one-shot argv: no --yolo, no session, one turn", () =>
    Effect.gen(function* () {
      const { instance, invocations } = yield* replaying("generate-text");
      yield* instance.generateText!(inputOf("generate-text"));
      const [call] = invocations();
      expect(call?.argv).toEqual(manifestOf("generate-text").turns[0]?.connectorArgs);
      expect(call?.argv).not.toContain("--yolo");
      expect(call?.argv).not.toContain("--tools-enable");
      expect(call?.argv).toContain("--no-session");
      expect(call?.argv.join(" ")).toContain("--max-turns 1");
    }).pipe(Effect.scoped),
  );

  it.live("runs in a temporary directory of its own and removes it", () =>
    Effect.gen(function* () {
      const { instance, invocations } = yield* replaying("generate-text");
      yield* instance.generateText!(inputOf("generate-text"));
      const cwd = invocations()[0]?.cwd ?? "";
      expect(NodePath.basename(cwd)).toMatch(/^poseidon-generate-/);
      expect(NodeFS.realpathSync(NodePath.dirname(cwd))).toBe(NodeFS.realpathSync(NodeOS.tmpdir()));
      expect(NodeFS.existsSync(cwd)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("removes what --no-session still left under ~/.commandcode/projects", () =>
    Effect.gen(function* () {
      const { instance, home } = yield* replaying("generate-text");
      const turn = manifestOf("generate-text").turns[0]!;
      // The layout the real run left, as its manifest lists it, beside a
      // directory of another session's that must survive.
      const projects = NodePath.join(home, ".commandcode", "projects");
      const left = NodePath.join(
        projects,
        NodePath.basename(NodePath.dirname(turn.transcriptPath!)),
      );
      const other = NodePath.join(projects, "other-project");
      NodeFS.mkdirSync(left, { recursive: true });
      NodeFS.mkdirSync(other, { recursive: true });
      for (const name of turn.projectDirListing)
        NodeFS.writeFileSync(NodePath.join(left, name), "");
      NodeFS.writeFileSync(NodePath.join(other, "someone-else.jsonl"), "");
      yield* instance.generateText!(inputOf("generate-text"));
      expect(turn.projectDirListing.length).toBeGreaterThan(0);
      expect(NodeFS.existsSync(left)).toBe(false);
      expect(NodeFS.readdirSync(other)).toEqual(["someone-else.jsonl"]);
    }).pipe(Effect.scoped),
  );

  it.live("runs again without --effort when the model refuses one, and remembers it", () =>
    Effect.gen(function* () {
      const scenario = "generate-text-effort-retry";
      const { instance, invocations } = yield* replaying(scenario, false);
      const [refused, answered] = manifestOf(scenario).turns;
      const text = yield* instance.generateText!({ ...inputOf(scenario), effort: "low" });
      expect(text).toBe("Fix typo in README install section");
      expect(invocations().map((call) => call.argv)).toEqual([
        refused?.connectorArgs,
        answered?.connectorArgs,
      ]);

      // The next call on the same model leaves --effort out from the start.
      yield* Effect.exit(instance.generateText!({ ...inputOf(scenario), effort: "low" }));
      expect(invocations().map((call) => call.argv)).toHaveLength(3);
      expect(invocations()[2]?.argv).toEqual(answered?.connectorArgs);
    }).pipe(Effect.scoped),
  );

  it.live("fails with the CLI's own words when the run without --effort fails too", () =>
    Effect.gen(function* () {
      const { instance, invocations } = yield* replaying("generate-text-effort");
      const error = yield* Effect.flip(
        instance.generateText!({ ...inputOf("generate-text-effort"), effort: "low" }),
      );
      expect(error._tag).toBe("GenerationFailed");
      expect(error.message).toContain(recorded("generate-text-effort", "stderr.txt").trim());
      const [withEffort, without] = invocations();
      expect(withEffort?.argv).toEqual(manifestOf("generate-text-effort").turns[0]?.connectorArgs);
      expect(without?.argv).not.toContain("--effort");
      expect(invocations()).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.live("fails when the run stops at its turn cap with no text", () =>
    Effect.gen(function* () {
      const { instance } = yield* replaying("max-turns");
      const error = yield* Effect.flip(
        instance.generateText!({ prompt: "Write a title.", model: manifestOf("max-turns").model }),
      );
      expect(error._tag).toBe("GenerationFailed");
      expect(error.message).toContain("stopped at the turn limit (--max-turns)");
    }).pipe(Effect.scoped),
  );
});

describe("generateTextArgs", () => {
  it("puts system in front of the prompt and maps effort onto Command Code's ladder", () => {
    const args = generateTextArgs({
      system: "Be brief.",
      prompt: "Title?",
      model: "m",
      effort: "minimal",
    });
    expect(args[1]).toBe("Be brief.\n\nTitle?");
    expect(args.slice(-5)).toEqual(["m", "--effort", "low", "--max-turns", "1"]);
  });

  it("leaves --effort out when none is asked for, and never sends a schema", () => {
    const args = generateTextArgs({ prompt: "Title?", model: "m", jsonSchema: { type: "object" } });
    expect(args).not.toContain("--effort");
    expect(args.join(" ")).not.toContain("object");
  });

  it("leaves --effort out for ultra, a rung Command Code does not have", () => {
    const args = generateTextArgs({ prompt: "Title?", model: "m", effort: "ultra" });
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("ultra");
  });
});

describe("fitArgument", () => {
  it("leaves a prompt that fits alone", () => {
    expect(fitArgument("Title?", "linux")).toBe("Title?");
  });

  it("cuts a prompt of multi-byte text under Linux's per-string limit in bytes", () => {
    // 50,000 characters of CJK is about 150 KB in UTF-8: past the limit though
    // the caller's character caps let it through.
    const prompt = `Write a message.\n\nDiff:\n${"漢".repeat(50_000)}`;
    const fitted = fitArgument(prompt, "linux");
    expect(Buffer.byteLength(fitted)).toBeLessThan(128 * 1024);
    expect(fitted.startsWith("Write a message.")).toBe(true);
    expect(fitted).toMatch(/漢\n\[… the rest was left out to fit the command line\]$/);
    expect(fitted).not.toContain("\uFFFD");
  });

  it("cuts by characters on Windows, never splitting a surrogate pair", () => {
    const fitted = fitArgument("😀".repeat(20_000), "win32");
    expect(fitted.length).toBeLessThanOrEqual(30_000);
    expect(fitted).not.toMatch(/[\uD800-\uDBFF]\n/);
  });
});

describe("answerOf the recorded failures", () => {
  it("reads an error result from the one capture of it", () => {
    // The raw 2026-09-15 capture, which exited 10: `run_error`, then an error
    // `result` line.
    const stdout = recorded(".", "probe-insufficient-credits.ndjson")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .join("\n");
    const answer = answerOf({ exitCode: 10, stdout, stderr: "" });
    expect("failure" in answer && answer.failure).toContain("top up at");
    expect("failure" in answer && answer.failure).toContain("You have insufficient credits");
  });

  it("tells the recorded effort refusal from other failures", () => {
    const refusal = {
      exitCode: 1,
      stdout: recorded("generate-text-effort", "stdout.ndjson"),
      stderr: recorded("generate-text-effort", "stderr.txt"),
    };
    expect(refusedEffort(refusal)).toBe(true);
    expect(refusedEffort({ ...refusal, stderr: "Unknown model" })).toBe(false);
    const answered = {
      exitCode: 0,
      stdout: recorded("generate-text", "stdout.ndjson"),
      stderr: recorded("generate-text", "stderr.txt"),
    };
    expect(refusedEffort(answered)).toBe(false);
  });

  it("says so when there is no result line", () => {
    const answer = answerOf({ exitCode: 0, stdout: "", stderr: "" });
    expect(answer).toEqual({ failure: "cmd gave no result line" });
  });
});

describe("removeLeftovers", () => {
  it("keeps a directory that also holds another session's files", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cmd-leftovers-"));
    const dir = NodePath.join(home, ".commandcode", "projects", "shared");
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "abc.meta.json"), "");
    NodeFS.writeFileSync(NodePath.join(dir, "other.jsonl"), "");
    await removeLeftovers(home, "abc");
    expect(NodeFS.readdirSync(dir)).toEqual(["other.jsonl"]);
    NodeFS.rmSync(home, { recursive: true, force: true });
  });
});

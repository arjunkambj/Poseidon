/**
 * The plugins extension against the real CLI's recorded answer.
 *
 * `fixtures/codex/plugins/` is this very script run through the testkit's
 * stdio tee against the operator's `codex`, on a scratch `CODEX_HOME` with a
 * local marketplace of two plugins, both installed with the real CLI
 * (`codex plugin marketplace add`, `codex plugin add`) before the tee is in
 * front, and one then disabled in `config.toml` by hand: the one
 * `codex plugin list --json` the extension ran, with what the CLI printed.
 *
 * The marketplace sits in the system temp directory, which the finaliser
 * scrubs to `<TMP>` and the replayer puts back as its own, so a replay writes
 * the same manifests there for the extension to read the descriptions from.
 *
 *     POSEIDON_RECORD_CODEX=1 POSEIDON_HOME=/tmp/poseidon-codex \
 *       pnpm -F @poseidon/connector-codex exec vitest run src/extensions/pluginsRecorded.test.ts
 *
 * records it again. No thread starts and no account is read, so it costs
 * nothing.
 */

import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll } from "vitest";

import { finalise, RECORD, realCodex, teeInFront } from "../../test/record";
import { replay } from "../../test/replay";
import { childEnv } from "../env";
import { parseVersion } from "../probe";
import { makeCodexPlugins } from "./plugins";

const SCENARIO = "plugins";
const MARKETPLACE = "scratch-market";
const MARKET_ROOT = NodePath.join(NodeOS.tmpdir(), "poseidon-codex-plugin-market");

/** The marketplace's files: its catalogue and each plugin's manifest. */
const MARKET_FILES: Readonly<Record<string, string>> = {
  ".agents/plugins/marketplace.json": JSON.stringify({
    name: MARKETPLACE,
    plugins: ["notes", "drafts"].map((name) => ({
      name,
      source: { source: "local", path: `./plugins/${name}` },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Productivity",
    })),
  }),
  "plugins/notes/.codex-plugin/plugin.json": JSON.stringify({
    name: "notes",
    version: "1.0.0",
    description: "Take notes.",
    skills: "./skills/",
    interface: { displayName: "Notes", shortDescription: "Keep short notes" },
  }),
  "plugins/notes/skills/take-note/SKILL.md":
    "---\nname: take-note\ndescription: Takes a note.\n---\n\nTake a note.\n",
  "plugins/drafts/.codex-plugin/plugin.json": JSON.stringify({
    name: "drafts",
    version: "1.0.0",
    description: "Draft replies.",
  }),
};

const writeMarket = (): void => {
  NodeFS.rmSync(MARKET_ROOT, { recursive: true, force: true });
  for (const [file, content] of Object.entries(MARKET_FILES)) {
    const path = NodePath.join(MARKET_ROOT, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
  }
};

const recorder = () => {
  const codex = realCodex();
  const cliVersion = parseVersion(execFileSync(codex, ["--version"], { encoding: "utf8" }));
  const codexHome = "/tmp/poseidon-codex/plugin-home";
  NodeFS.rmSync(codexHome, { recursive: true, force: true });
  NodeFS.mkdirSync(codexHome, { recursive: true });
  writeMarket();
  // The installs are the CLI's own, before the tee is in front.
  const env = childEnv(process.env, { codexHome });
  const setup = (args: ReadonlyArray<string>) =>
    execFileSync(codex, [...args], { cwd: NodeOS.tmpdir(), env, stdio: "ignore" });
  setup(["plugin", "marketplace", "add", MARKET_ROOT]);
  setup(["plugin", "add", `notes@${MARKETPLACE}`]);
  setup(["plugin", "add", `drafts@${MARKETPLACE}`]);
  const config = NodePath.join(codexHome, "config.toml");
  const toml = NodeFS.readFileSync(config, "utf8");
  const disabled = toml.replace(
    `[plugins."drafts@${MARKETPLACE}"]\nenabled = true`,
    `[plugins."drafts@${MARKETPLACE}"]\nenabled = false`,
  );
  if (disabled === toml) throw new Error(`drafts is not enabled in ${config} as expected`);
  NodeFS.writeFileSync(config, disabled);
  const { rawDir, launcher } = teeInFront(codex, SCENARIO);
  return {
    binaryPath: launcher,
    codexHome,
    finish: () =>
      finalise({
        codex,
        scenario: SCENARIO,
        rawDir,
        description:
          "The plugins extension on a scratch CODEX_HOME with a local marketplace of two plugins, both installed with the CLI and one then disabled in config.toml: codex plugin list --json.",
        cliVersion: cliVersion ?? "unknown",
        model: "default",
        prompts: [],
      }),
  };
};

const replayer = () => {
  const replayed = replay(SCENARIO);
  writeMarket();
  return {
    binaryPath: replayed.binaryPath,
    codexHome: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-plugin-home-")),
    finish: () => {
      NodeFS.rmSync(MARKET_ROOT, { recursive: true, force: true });
      replayed.assertPlayedOut();
    },
  };
};

const driver = RECORD ? recorder() : replayer();
afterAll(() => {
  driver.finish();
});

const plugins = makeCodexPlugins({
  binary: () => ({ command: driver.binaryPath, display: driver.binaryPath }),
  env: () => childEnv(process.env, { codexHome: driver.codexHome }),
});

describe("the Codex plugins extension, recorded", () => {
  it.effect("lists the installed plugins with their marketplace, state and description", () =>
    Effect.gen(function* () {
      expect(yield* plugins.list({ workspaceRoot: null })).toEqual([
        {
          name: "notes",
          source: MARKETPLACE,
          scope: "user",
          enabled: true,
          description: "Keep short notes",
        },
        {
          name: "drafts",
          source: MARKETPLACE,
          scope: "user",
          enabled: false,
          description: "Draft replies.",
        },
      ]);
    }),
  );
});

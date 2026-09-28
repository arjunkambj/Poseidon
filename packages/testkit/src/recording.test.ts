/**
 * The shared recording layout, read against the real Command Code recordings.
 *
 * Those manifests predate the format fields and are never edited, so these
 * tests are the proof that the defaults applied in code keep them readable.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";

import {
  fixturesRoot,
  readFrames,
  readManifest,
  recordingNames,
  RECORDING_FORMAT_VERSION,
} from "./recording";
import { cmdReplayer, loadRecording, RECORDINGS_DIR, turnFrames } from "./replayCmdProcess";

describe("readManifest", () => {
  it("reads a legacy Command Code manifest as version 1 over stdio NDJSON", () => {
    const manifest = readManifest("cmd", "shell-allow");
    expect(manifest.formatVersion).toBe(RECORDING_FORMAT_VERSION);
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.kind).toBe("cmd");
    expect(manifest.transport).toBe("stdio-ndjson");
    expect(manifest.scenario).toBe("shell-allow");
    expect(manifest.real).toBe(true);
    expect(manifest.cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("keeps the fields a transport's own layout adds", () => {
    const manifest = readManifest<{ readonly turns: ReadonlyArray<unknown> }>("cmd", "resume");
    expect(manifest.turns).toHaveLength(2);
  });

  it("names a scenario after its directory when the manifest does not", () => {
    expect(readManifest("cmd", "probe").scenario).toBe("probe");
  });

  it("refuses a kind with no recordings", () => {
    expect(() => readManifest("no-such-kind", "text")).toThrow();
  });
});

describe("the fixtures/<kind>/ convention", () => {
  it("puts the Command Code recordings under fixtures/cmd", () => {
    expect(fixturesRoot("cmd")).toBe(RECORDINGS_DIR);
    expect(NodePath.basename(NodePath.dirname(RECORDINGS_DIR))).toBe("fixtures");
  });

  it("loads every Command Code recording through the shared reader", () => {
    const names = recordingNames("cmd");
    expect(names).not.toContain("probe");
    // `fixtures/claude/plugins/` is config files, not a recording.
    expect(recordingNames("claude")).not.toContain("plugins");
    expect(names.length).toBeGreaterThanOrEqual(13);
    for (const name of names) {
      expect(readManifest("cmd", name).transport).toBe("stdio-ndjson");
      expect(loadRecording(name).turns.length).toBeGreaterThan(0);
    }
  });
});

describe("the agent-browser recordings", () => {
  it("are real captures through the bridge, one per scenario", () => {
    expect(recordingNames("agent-browser")).toEqual([
      "cli-attach",
      "cli-empty-thread",
      "cli-last-tab-gone",
      "cli-reap",
      "cli-tab-gone",
      "cli-tabs-pinned",
      "connect-and-drive",
      "empty-thread-createTarget",
      "popup",
      "reload",
      "tab-new-close",
    ]);
    for (const name of recordingNames("agent-browser")) {
      const manifest = readManifest<{ readonly steps: ReadonlyArray<unknown> }>(
        "agent-browser",
        name,
      );
      // The `cli-*` scenarios are the server driver's command sequences, read
      // for their envelopes; the rest are read for their CDP frames.
      expect(manifest.transport).toBe(name.startsWith("cli-") ? "cli-json" : "cdp-websocket");
      expect(manifest.cliVersion).toBe("0.38.1");
      expect(manifest.steps.length).toBeGreaterThan(0);
      const frames = readFrames("agent-browser", name);
      expect(frames.some((frame) => frame.dir === "from-harness")).toBe(true);
      expect(frames.some((frame) => frame.dir === "to-harness")).toBe(true);
    }
  });

  it("carry no capability, launch key or port of the run that made them", () => {
    for (const name of recordingNames("agent-browser")) {
      for (const file of ["frames.jsonl", "manifest.json"]) {
        const text = NodeFS.readFileSync(
          NodePath.join(fixturesRoot("agent-browser"), name, file),
          "utf8",
        );
        expect(text).not.toMatch(/\b[0-9a-f]{64}\b/);
        expect(text).not.toMatch(/127\.0\.0\.1:\d/);
        expect(text).not.toContain("/cdp/");
      }
    }
  });
});

describe("turnFrames", () => {
  it("tags stdout and hook traffic with the way it travelled", () => {
    const hooks = JSON.parse(
      NodeFS.readFileSync(NodePath.join(RECORDINGS_DIR, "shell-allow", "hooks.json"), "utf8"),
    ) as ReadonlyArray<unknown>;
    const turn = loadRecording("shell-allow").turns[0]!;
    const frames = turnFrames(turn);

    const stdout = frames.filter((frame) => frame.channel === "stdout");
    expect(stdout).toHaveLength(turn.frames.length);
    expect(stdout.every((frame) => frame.dir === "from-harness")).toBe(true);

    const asked = frames.filter(
      (frame) => frame.channel === "hook" && frame.dir === "from-harness",
    );
    const answered = frames.filter(
      (frame) => frame.channel === "hook" && frame.dir === "to-harness",
    );
    expect(hooks.length).toBeGreaterThan(0);
    expect(asked).toHaveLength(hooks.length);
    expect(answered).toHaveLength(hooks.length);
    expect(asked[0]?.data).toEqual(turn.hooks[0]?.stdin);
    expect(answered[0]?.data).toEqual(turn.hooks[0]?.answer);
  });
});

describe("cmdReplayer", () => {
  it("is the stdio NDJSON replayer for the cmd kind", () => {
    expect(cmdReplayer.kind).toBe("cmd");
    expect(cmdReplayer.transport).toBe("stdio-ndjson");
    const config = cmdReplayer.config("text", { home: "/tmp/replay-home" });
    expect(config.extraEnv.POSEIDON_REPLAY_DIR).toBe(NodePath.join(RECORDINGS_DIR, "text"));
  });
});

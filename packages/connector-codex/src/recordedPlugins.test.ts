/**
 * A Poseidon plugin in a Codex session, against `fixtures/codex/plugin-skill/`:
 * the plugin's skills directory handed over with `skills/extraRoots/set`
 * before the thread opens, its MCP server in `thread/start`'s config as one
 * dotted key beside `poseidon`'s, and a turn whose skill reference is a
 * `skill` input naming the `SKILL.md` that `skills/list` gave — which the CLI
 * added to the turn itself, so the model answered without reading a file.
 *
 * The replay checks each method in order and the load-bearing params; the
 * testkit's tee sits in front of the replayer as well, so the test also reads
 * what the connector sent in this run: the extra roots, the config, the
 * reviewer and the turn's input.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { makeStreamCollector } from "@poseidon/connector-sdk/streamCollector";
import { makeConnectorInstanceId, makeProjectId, makeThreadId } from "@poseidon/contracts/ids";
import { makeTeeLauncher } from "@poseidon/testkit/sdkStreamRecording";
import * as Effect from "effect/Effect";

import { SCRATCH_PLUGIN, SCRATCH_SKILL } from "../test/plugin";
import { isPidGone, replay } from "../test/replay";
import { ofType, prompts, rows, SETTINGS, stopReasons } from "../test/replaySession";
import { testServices } from "../test/services";
import { makeCodexConnectorDefinition } from "./definition";
import { pluginMcpKey } from "./plugins";

const SCENARIO = "plugin-skill";

interface Sent {
  readonly method?: string;
  readonly id?: unknown;
  readonly params?: Record<string, unknown>;
}

/** What the tee saw the connector send, in order. */
const sentThrough = (rawDir: string): ReadonlyArray<Sent> =>
  NodeFS.readFileSync(NodePath.join(rawDir, "invocation-1.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { dir: string; data: Sent })
    .filter((frame) => frame.dir === "to-harness")
    .map((frame) => frame.data);

describe("a Codex session replaying codex/plugin-skill", () => {
  it.live("hands the plugin's skills and MCP server over, and attaches the referenced skill", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const played = replay(SCENARIO);
        const rawDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-plugin-tee-"));
        const workspace = NodePath.join(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-session-")),
          SCENARIO,
        );
        NodeFS.mkdirSync(workspace);
        const instance = yield* makeCodexConnectorDefinition().createInstance({
          instanceId: makeConnectorInstanceId(),
          config: { binaryPath: makeTeeLauncher({ realBinary: played.binaryPath, rawDir }) },
          services: yield* testServices({ plugins: [SCRATCH_PLUGIN] }),
        });
        const handle = yield* instance.startSession({
          threadId: makeThreadId(),
          projectId: makeProjectId(),
          workspaceRoot: workspace,
          settings: SETTINGS,
        });
        const collector = yield* makeStreamCollector(handle.events);
        yield* handle.send({
          text: prompts(SCENARIO)[0]!,
          attachments: [],
          mentions: [],
          references: [{ kind: "skill", name: SCRATCH_SKILL.name }],
        });
        yield* collector.awaitItem((event) => event.type === "turn.completed");
        yield* handle.close();
        yield* collector.awaitDone;
        const events = yield* collector.collected;
        played.assertPlayedOut();
        expect(played.pids().every(isPidGone)).toBe(true);

        const sent = sentThrough(rawDir);
        expect(sent.filter((frame) => frame.id !== undefined).map((frame) => frame.method)).toEqual(
          ["initialize", "skills/extraRoots/set", "thread/start", "skills/list", "turn/start"],
        );
        const roots = sent.find((frame) => frame.method === "skills/extraRoots/set");
        expect(roots?.params).toEqual({ extraRoots: SCRATCH_PLUGIN.skillsDirs });
        const start = sent.find((frame) => frame.method === "thread/start");
        expect(start?.params?.config).toEqual({
          [`mcp_servers.${pluginMcpKey("scratch", "words")}`]: { url: "http://127.0.0.1:9/mcp" },
        });
        expect(start?.params?.approvalsReviewer).toBe("user");
        const turnStart = sent.find((frame) => frame.method === "turn/start");
        expect(turnStart?.params?.input).toEqual([
          { type: "text", text: prompts(SCENARIO)[0], text_elements: [] },
          {
            type: "skill",
            name: SCRATCH_SKILL.name,
            // As `skills/list` answered it, `<SCRATCH>` put back as this run's.
            path: NodePath.join(
              NodeFS.realpathSync(NodePath.dirname(workspace)),
              "plugin-skill-plugin",
              "skills",
              SCRATCH_SKILL.name,
              "SKILL.md",
            ),
          },
        ]);

        // The thread started the plugin's server beside Poseidon's own
        // (nothing listens on either, so both failed), and the model answered
        // from the skill with no command, so nothing asked for approval.
        const mcp = ofType(events, "mcp.status.updated").at(-1)!.payload.servers;
        expect(mcp).toContainEqual({ name: "plugin-scratch-words", status: "failed" });
        expect(mcp).toContainEqual({ name: "poseidon", status: "failed" });
        expect(ofType(events, "request.opened")).toEqual([]);
        expect(rows(events, "assistant_message").at(-1)!.text).toBe(SCRATCH_SKILL.word);
        expect(stopReasons(events)).toEqual(["end_turn"]);
        expect(ofType(events, "event.unmapped")).toEqual([]);
        expect(ofType(events, "session.warning")).toEqual([]);
      }),
    ),
  );
});

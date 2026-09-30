/**
 * A turn sent to a Claude Code CLI that is not signed in, through the whole
 * product.
 *
 * The CLI answers every message with its own "Not logged in" line and an error
 * result, without calling the API, so this is the one Claude scenario that
 * spends nothing to record. It proves what the others rest on — the probe, the
 * session handshake with the real MCP gateway, the turn's lifecycle and the
 * close, each through the real server against a recording made through it —
 * and it pins what a signed-out user sees: the connector marked
 * not-authenticated, and an error row that names the command to run.
 */

import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { connect, isSettled, startTurn, staticCredentials } from "../e2e/harness";
import { claudeScenario } from "./harness";

const PROMPT = "Reply with exactly: pong";

claudeScenario(
  "a turn against a signed-out CLI",
  {
    scenario: "signed-out-turn",
    description:
      "One turn through the real server against a CLI that is not signed in: the probe finds no login, and the CLI answers the message with its own sign-in error and an error result without calling the API.",
    prompts: [PROMPT],
    signedOut: true,
  },
  "says the CLI is signed out and names the command that signs it in",
  (run) =>
    Effect.gen(function* () {
      const server = yield* run.boot;
      const client = yield* connect(Effect.succeed(staticCredentials(server)));

      // The connectors page's own reading: the instance is there and says why
      // it cannot work.
      const connectors = yield* (yield* client.rpc)
        ["connectors.list"]({ refresh: true })
        .pipe(Effect.orDie);
      const claude = connectors.find(
        (entry) => entry.connectorInstanceId === run.connectorInstanceId,
      );
      expect(claude?.probe.status).toBe("not-authenticated");
      expect(claude?.probe.loginCommand).toContain("auth login");

      const open = yield* run.openThread(client);
      const started = yield* startTurn(client, open, { text: PROMPT });
      const done = yield* open.view.awaitValue(
        (view) => isSettled(view) && view.items.some((item) => item.kind === "error"),
        started,
      );

      // The prompt is on the timeline, the answer is an error row naming the
      // login command, and there is no assistant row pretending otherwise.
      expect(done.items.filter((item) => item.kind === "user_message")).toHaveLength(1);
      const errors = done.items.filter((item) => item.kind === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]!.text).toContain("not signed in");
      expect(errors[0]!.text).toContain("auth login");
      expect(done.items.some((item) => item.kind === "assistant_message")).toBe(false);

      // The session is bound to the id the connector minted for the CLI.
      const ref = done.session?.sessionRef as { readonly sessionId?: unknown } | undefined;
      expect(typeof ref?.sessionId).toBe("string");
    }),
);

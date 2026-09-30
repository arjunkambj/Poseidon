/**
 * What the connector's tests lend an instance in place of the server: a
 * permission ladder that answers one fixed verdict (or the test's own), an
 * MCP endpoint nothing listens on, a throwaway attachments directory, a
 * silent logger (or the test's own, for a live run's debug output), and no
 * Poseidon plugins unless the test names some.
 *
 * The MCP URL points at the discard port on loopback, so the CLI's connection
 * attempt is refused at once and the session's own traffic is all that runs.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type {
  ConnectorEndpoint,
  ConnectorPermissions,
  ConnectorServices,
  PermissionDecision,
} from "@poseidon/connector-sdk/definition";
import type { SessionPlugin } from "@poseidon/connector-sdk/plugins";
import * as Effect from "effect/Effect";

export const UNREACHABLE_MCP = {
  url: "http://127.0.0.1:9/mcp",
  bearer: "poseidon-test-bearer-0000",
} as const;

export const testServices = (
  options: {
    readonly decision?: PermissionDecision;
    /** A ladder of the test's own, in place of the one fixed verdict. */
    readonly decide?: ConnectorPermissions["decide"];
    /** A logger of the test's own, in place of the silent one. */
    readonly logger?: ConnectorServices["logger"];
    /** An MCP endpoint that answers, in place of the unreachable one. */
    readonly mcp?: ConnectorEndpoint;
    /** Poseidon plugins every session loads; none when absent. */
    readonly plugins?: ReadonlyArray<SessionPlugin>;
  } = {},
): Effect.Effect<ConnectorServices> =>
  Effect.clockWith((clock) =>
    Effect.sync((): ConnectorServices => ({
      mcpEndpoint: () => Effect.succeed(options.mcp ?? UNREACHABLE_MCP),
      hookEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:9/hooks", bearer: "unused" }),
      permissions: {
        decide: options.decide ?? (() => Effect.succeed(options.decision ?? "prompt")),
      },
      attachmentsDir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-attachments-")),
      logger: options.logger ?? { log: () => Effect.void },
      clock,
      ...(options.plugins === undefined
        ? {}
        : { sessionPlugins: () => Effect.succeed(options.plugins ?? []) }),
    })),
  );

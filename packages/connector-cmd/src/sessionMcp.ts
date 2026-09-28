/**
 * The MCP servers one Command Code session registers in the project's local
 * scope, and takes out again when it closes.
 *
 * Poseidon's own server goes in as `poseidon`, as it always has; each enabled
 * plugin's servers go in beside it as `poseidon-plugin-<plugin>-<server>`,
 * through the same `cmd mcp add-json --scope local` and the same per-project
 * count (`config.ts`), so the first of two threads in one project to close
 * leaves the other's servers alone. A server the CLI refuses is a warning, not
 * a failed session.
 */

import type { ConnectorEndpoint, ConnectorServices } from "@poseidon/connector-sdk/definition";
import type { SessionMcpServer, SessionPlugin } from "@poseidon/connector-sdk/plugins";
import type { ThreadId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";

import {
  POSEIDON_MCP_NAME,
  removeMcpEntry,
  upsertMcpEntry,
  type McpEntry,
  type McpRegistration,
} from "./config";

export interface SessionMcp {
  /** Poseidon's endpoint, for the turns' bearer; null when the server has none. */
  readonly endpoint: ConnectorEndpoint | null;
  /** Takes out every entry this session registered; runs once. */
  readonly release: Effect.Effect<void>;
}

/** The name a plugin's server is registered under: only characters every config key takes. */
export const pluginMcpName = (plugin: string, server: string): string =>
  `poseidon-plugin-${plugin}-${server}`.replace(/[^A-Za-z0-9_-]/g, "-");

const entryFor = (server: SessionMcpServer): McpEntry | null => {
  if (server.transport === "http") {
    return server.url === undefined
      ? null
      : {
          transport: "http",
          url: server.url,
          ...(server.headers === undefined ? {} : { headers: server.headers }),
        };
  }
  return server.command === undefined
    ? null
    : {
        transport: "stdio",
        command: server.command,
        ...(server.args === undefined ? {} : { args: server.args }),
        ...(server.env === undefined ? {} : { env: server.env }),
      };
};

export const registerSessionMcp = (input: {
  readonly registration: McpRegistration;
  readonly services: Pick<ConnectorServices, "mcpEndpoint">;
  readonly threadId: ThreadId;
  readonly plugins: ReadonlyArray<SessionPlugin>;
  readonly warn: (message: string) => Effect.Effect<void>;
}): Effect.Effect<SessionMcp> =>
  Effect.gen(function* () {
    const registered: Array<string> = [];
    const endpoint = yield* input.services
      .mcpEndpoint(input.threadId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    // An empty url is how a server without an MCP endpoint says "nothing to
    // configure": skip registering Poseidon's own entry entirely.
    if (endpoint !== null && endpoint.url !== "") {
      const ok = yield* upsertMcpEntry(input.registration, { url: endpoint.url }).pipe(
        Effect.catch((error) =>
          input.warn(`could not register the MCP server: ${String(error)}`).pipe(Effect.as(false)),
        ),
      );
      if (ok) {
        registered.push(POSEIDON_MCP_NAME);
      } else {
        yield* input.warn(
          "the harness refused to register Poseidon's MCP server, so its tools are unavailable this session",
        );
      }
    }
    for (const plugin of input.plugins) {
      for (const server of plugin.mcpServers) {
        const entry = entryFor(server);
        const name = pluginMcpName(plugin.name, server.name);
        if (entry === null || registered.includes(name)) continue;
        if (yield* upsertMcpEntry(input.registration, entry, name)) {
          registered.push(name);
        } else {
          yield* input.warn(
            `the harness refused to register the MCP server "${server.name}" of the plugin "${plugin.name}", so its tools are unavailable this session`,
          );
        }
      }
    }
    let released = false;
    return {
      endpoint,
      release: Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        return Effect.forEach(registered, (name) => removeMcpEntry(input.registration, name), {
          discard: true,
        });
      }),
    };
  });

/**
 * The MCP surface over a real loopback server:
 *
 * - `POST /mcp` without a bearer → 401; a minted bearer → JSON-RPC works.
 * - `initialize` / `tools/list` answer the protocol handshake, echoing a
 *   protocol version the client asked for when we speak it.
 * - A non-loopback `Origin` is refused, and `GET /mcp` says 405 rather than
 *   looking like the wrong url.
 * - `tools/call browser_open` drives the fake driver through the session's
 *   serialized queue — the same path `mcp__poseidon__browser_open` takes.
 * - `revoke` kills the bearer — dead requests 401.
 * - A snapshot past the 64KB cap is capped in `structuredContent` too, not
 *   only in the text.
 * - A bearer minted with the Browser plugin off lists no tools and refuses a
 *   browser call; the state at mint holds for the session's life.
 */

import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { makeThreadId } from "@poseidon/contracts/ids";
import { makeRegistry } from "@poseidon/connector-sdk/registry";

import type { BrowserDriver } from "../browser/driver";
import { makeFakeDriver, type FakePage } from "../browser/fakeDriver";
import { makeService, type OpenDriverOptions } from "../browser/BrowserService";
import { OrchestrationEngine } from "../orchestration/Engine";
import { ConnectorSelection, SessionManager } from "../orchestration/SessionManager";
import { EventStore } from "../persistence/EventStore";
import { ReadModelStore } from "../persistence/ReadModels";
import { testLayer as sqliteTestLayer } from "../persistence/Sqlite";
import { PermissionService } from "../permissions/PermissionService";
import { PluginRegistry } from "../plugins/PluginRegistry";
import { BrowserService } from "../rpc/services";
import { mcpRoutesLayer } from "./httpRoute";
import { BROWSER_PLUGIN_OFF_MESSAGE, capStructured, capText, McpGateway } from "./McpGateway";

const threadId = makeThreadId();

const fakePage = (): FakePage => ({
  url: "about:blank",
  title: "Blank",
  lines: [{ role: "link", name: "Docs", ref: "e1", url: "https://example.com/docs" }],
  history: [],
  historyIndex: -1,
});

const permissionsStub = Layer.succeed(
  PermissionService,
  PermissionService.of({
    decide: () => Effect.succeed("allow" as const),
    rules: () => Effect.succeed([]),
    addRule: () => Effect.void,
  }),
);

/** A registry whose Browser plugin follows `state.on`; nothing else is used. */
const browserSwitch = (state: { on: boolean }) =>
  Layer.succeed(
    PluginRegistry,
    PluginRegistry.of({
      list: Effect.succeed({ globalDir: "", plugins: [] }),
      setEnabled: () => Effect.die("unused"),
      openFolder: Effect.void,
      sessionPlugins: () => Effect.succeed([]),
      browserEnabled: Effect.sync(() => state.on),
      materializeBuiltins: Effect.void,
    }),
  );

const buildStack = (
  openDriver: (
    options: OpenDriverOptions,
  ) => Effect.Effect<BrowserDriver, { readonly message: string }, never>,
  plugins: Layer.Layer<PluginRegistry> | Layer.Layer<never> = Layer.empty,
) =>
  Effect.gen(function* () {
    const sqliteContext = yield* Layer.build(sqliteTestLayer());
    const sqlite = Layer.succeedContext(sqliteContext);
    const persistence = Layer.mergeAll(
      sqlite,
      Layer.mergeAll(EventStore.layer, ReadModelStore.layer).pipe(Layer.provide(sqlite)),
    );
    const engine = OrchestrationEngine.layer.pipe(Layer.provide(persistence));
    const registry = yield* makeRegistry([]);
    const selection = ConnectorSelection.fromRegistry(registry);
    const manager = SessionManager.layer.pipe(Layer.provide(Layer.mergeAll(engine, selection)));

    const http = NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" });
    const httpContext = yield* Layer.build(http);
    const httpLayer = Layer.succeedContext(httpContext);

    const browser = Layer.effect(
      BrowserService,
      makeService({ mode: "owned-chromium", openDriver }),
    ).pipe(Layer.provide(Layer.mergeAll(engine, permissionsStub)));

    const gateway = McpGateway.layer.pipe(
      Layer.provide(Layer.mergeAll(browser, engine, manager, httpLayer, plugins)),
    );

    const app = HttpRouter.serve(mcpRoutesLayer).pipe(
      Layer.provide(gateway),
      Layer.provide(httpLayer),
    );
    const context = yield* Layer.build(Layer.mergeAll(app, gateway));

    const server = Context.get(httpContext, HttpServer.HttpServer);
    const address = server.address;
    const port = typeof address === "object" && "port" in address ? address.port : 0;

    return { gateway: Context.get(context, McpGateway), port };
  });

interface JsonRpcResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: {
    readonly result?: {
      readonly tools?: ReadonlyArray<{ readonly name: string }>;
      readonly protocolVersion?: string;
      readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
      readonly structuredContent?: Record<string, unknown>;
      readonly isError?: boolean;
    };
    readonly error?: { readonly code: number; readonly message: string };
  } | null;
}

const post = async (
  url: string,
  bearer: string | null,
  message: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<JsonRpcResult> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      ...extraHeaders,
    },
    body: JSON.stringify(message),
  });
  return read(response);
};

const read = async (response: Response): Promise<JsonRpcResult> => {
  const text = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: text === "" ? null : (JSON.parse(text) as JsonRpcResult["body"]),
  };
};

describe("McpGateway", () => {
  it.live("bearer-gated JSON-RPC: initialize, tools/list, tools/call, revoke", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { gateway, port } = yield* buildStack(() =>
          Effect.succeed(makeFakeDriver(fakePage())),
        );
        const url = `http://127.0.0.1:${port}/mcp`;

        // No bearer → 401 before JSON-RPC is even parsed.
        const anonymous = yield* Effect.promise(() =>
          post(url, null, { jsonrpc: "2.0", id: 1, method: "initialize" }),
        );
        expect(anonymous.status).toBe(401);
        expect(anonymous.headers["www-authenticate"]).toContain("Bearer");
        const wrong = yield* Effect.promise(() =>
          post(url, "not-a-token", { jsonrpc: "2.0", id: 1, method: "initialize" }),
        );
        expect(wrong.status).toBe(401);

        const endpoint = yield* gateway.endpoint(threadId);
        expect(endpoint.url).toBe(url);
        const bearer = endpoint.bearer;

        const init = yield* Effect.promise(() =>
          post(url, bearer, { jsonrpc: "2.0", id: 1, method: "initialize" }),
        );
        expect(init.body?.result?.protocolVersion).toBe("2025-06-18");

        // A client that asks for a version we speak gets that version back,
        // not our own; one we don't speak gets ours.
        const older = yield* Effect.promise(() =>
          post(url, bearer, {
            jsonrpc: "2.0",
            id: 11,
            method: "initialize",
            params: { protocolVersion: "2024-11-05" },
          }),
        );
        expect(older.body?.result?.protocolVersion).toBe("2024-11-05");
        const unknown = yield* Effect.promise(() =>
          post(url, bearer, {
            jsonrpc: "2.0",
            id: 12,
            method: "initialize",
            params: { protocolVersion: "1999-01-01" },
          }),
        );
        expect(unknown.body?.result?.protocolVersion).toBe("2025-06-18");

        const list = yield* Effect.promise(() =>
          post(url, bearer, { jsonrpc: "2.0", id: 2, method: "tools/list" }),
        );
        const names = (list.body?.result?.tools ?? []).map((tool) => tool.name);
        expect(names).toContain("browser_open");
        expect(names).toContain("browser_snapshot");
        expect(names).toContain("browser_eval");

        // tools/call goes through the fake driver's page.
        const open = yield* Effect.promise(() =>
          post(url, bearer, {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "browser_open", arguments: { url: "https://example.com" } },
          }),
        );
        expect(open.body?.result?.isError).toBe(false);
        expect(JSON.stringify(open.body?.result?.structuredContent ?? {})).toContain(
          "https://example.com",
        );

        const badTool = yield* Effect.promise(() =>
          post(url, bearer, {
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "browser_nope", arguments: {} },
          }),
        );
        expect(badTool.body?.error?.code).toBe(-32602);

        // A website reaching loopback is refused before the token matters.
        const crossOrigin = yield* Effect.promise(() =>
          post(
            url,
            bearer,
            { jsonrpc: "2.0", id: 6, method: "ping" },
            {
              origin: "https://evil.example",
            },
          ),
        );
        expect(crossOrigin.status).toBe(403);

        // `Origin: null` is an *opaque* origin — what a page sends from a
        // sandboxed iframe, a `data:` document or a `file:` page. It used to be
        // in the allowed set alongside "no header at all", which is the only
        // thing the harness actually sends, so any remote page could put its
        // fetches into the allowed class at will.
        const opaqueOrigin = yield* Effect.promise(() =>
          post(url, bearer, { jsonrpc: "2.0", id: 7, method: "ping" }, { origin: "null" }),
        );
        expect(opaqueOrigin.status).toBe(403);

        // There is no GET stream on this transport — say so instead of 404.
        const stream = yield* Effect.promise(() => fetch(url).then(read));
        expect(stream.status).toBe(405);
        expect(stream.headers.allow).toBe("POST");

        // ...but not to a page: the answer says the endpoint is here.
        const probed = yield* Effect.promise(() =>
          fetch(url, { headers: { origin: "https://evil.example" } }).then(read),
        );
        expect(probed.status).toBe(403);

        // Revoked bearers die — dead requests never reach a session.
        yield* gateway.revoke(threadId);
        const dead = yield* Effect.promise(() =>
          post(url, bearer, { jsonrpc: "2.0", id: 5, method: "ping" }),
        );
        expect(dead.status).toBe(401);
      }),
    ),
  );
});

describe("the Browser plugin switch", () => {
  const listNames = (url: string, bearer: string) =>
    Effect.promise(() => post(url, bearer, { jsonrpc: "2.0", id: 1, method: "tools/list" })).pipe(
      Effect.map((list) => (list.body?.result?.tools ?? []).map((tool) => tool.name)),
    );
  const callOpen = (url: string, bearer: string) =>
    Effect.promise(() =>
      post(url, bearer, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "browser_open", arguments: { url: "https://example.com" } },
      }),
    );

  it.live("off at mint: no tools are listed and a browser call is refused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { gateway, port } = yield* buildStack(
          () => Effect.succeed(makeFakeDriver(fakePage())),
          browserSwitch({ on: false }),
        );
        const url = `http://127.0.0.1:${port}/mcp`;
        const { bearer } = yield* gateway.endpoint(threadId);

        expect(yield* listNames(url, bearer)).toEqual([]);
        const call = yield* callOpen(url, bearer);
        expect(call.status).toBe(200);
        expect(call.body?.result?.isError).toBe(true);
        expect(call.body?.result?.content?.[0]?.text).toBe(BROWSER_PLUGIN_OFF_MESSAGE);
        expect(BROWSER_PLUGIN_OFF_MESSAGE).toContain("Customize → Plugins");

        // The rest of the protocol still answers: the session just has no tools.
        const ping = yield* Effect.promise(() =>
          post(url, bearer, { jsonrpc: "2.0", id: 3, method: "ping" }),
        );
        expect(ping.body?.result).toEqual({});
      }),
    ),
  );

  it.live("on at mint: the browser tools are listed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { gateway, port } = yield* buildStack(
          () => Effect.succeed(makeFakeDriver(fakePage())),
          browserSwitch({ on: true }),
        );
        const url = `http://127.0.0.1:${port}/mcp`;
        const { bearer } = yield* gateway.endpoint(threadId);

        const names = yield* listNames(url, bearer);
        expect(names).toContain("browser_open");
        expect(names).toContain("browser_snapshot");
        expect((yield* callOpen(url, bearer)).body?.result?.isError).toBe(false);
      }),
    ),
  );

  it.live("toggled after mint: a minted bearer keeps its state, a new one follows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = { on: true };
        const { gateway, port } = yield* buildStack(
          () => Effect.succeed(makeFakeDriver(fakePage())),
          browserSwitch(state),
        );
        const url = `http://127.0.0.1:${port}/mcp`;
        const running = (yield* gateway.endpoint(threadId)).bearer;

        state.on = false;
        expect(yield* listNames(url, running)).toContain("browser_open");
        expect((yield* callOpen(url, running)).body?.result?.isError).toBe(false);
        const started = (yield* gateway.endpoint(makeThreadId())).bearer;
        expect(yield* listNames(url, started)).toEqual([]);

        state.on = true;
        expect(yield* listNames(url, started)).toEqual([]);
        const later = (yield* gateway.endpoint(makeThreadId())).bearer;
        expect(yield* listNames(url, later)).toContain("browser_open");
      }),
    ),
  );
});

describe("oversized results", () => {
  it.live("caps a large snapshot's structuredContent, and the text says it was cut", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Thousands of refs: the snapshot text and its refs map are each well
        // past 64KB.
        const page: FakePage = {
          ...fakePage(),
          lines: Array.from({ length: 4000 }, (_, index) => ({
            role: "link",
            name: `A link with a reasonably long accessible name, number ${index}`,
            ref: `e${index}`,
          })),
        };
        const { gateway, port } = yield* buildStack(() => Effect.succeed(makeFakeDriver(page)));
        const { bearer } = yield* gateway.endpoint(threadId);
        const url = `http://127.0.0.1:${port}/mcp`;
        yield* Effect.promise(() =>
          post(url, bearer, {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "browser_open", arguments: { url: "https://example.com/big" } },
          }),
        );
        const snapshot = yield* Effect.promise(() =>
          post(url, bearer, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "browser_snapshot", arguments: {} },
          }),
        );

        const result = snapshot.body?.result;
        expect(result?.isError).toBe(false);
        const structured = result?.structuredContent ?? {};
        expect(Buffer.byteLength(JSON.stringify(structured), "utf8")).toBeLessThanOrEqual(
          64 * 1024,
        );
        expect(structured).toMatchObject({
          url: "https://example.com/big",
          title: "Fake https://example.com/big",
          truncated: true,
        });
        expect(structured.snapshot).toBeUndefined();
        expect(structured.refs).toBeUndefined();
        const text = result?.content?.[0]?.text ?? "";
        expect(text).toContain("truncated at 65536 bytes");
        expect(text).toContain("e0");
      }),
    ),
  );
});

describe("capStructured", () => {
  it("leaves a result inside the cap alone", () => {
    const data = { url: "https://example.com/", title: "Example", snapshot: "- link" };
    expect(capStructured(data)).toBe(data);
  });

  it("keeps only where the page is, and only when that is short", () => {
    const capped = capStructured({
      origin: "https://example.com",
      url: `https://example.com/?q=${"x".repeat(5000)}`,
      title: "Example",
      text: "の".repeat(40_000),
    });
    expect(capped).toEqual({
      origin: "https://example.com",
      title: "Example",
      truncated: true,
      bytes: expect.any(Number),
    });
  });
});

describe("capText", () => {
  it("caps on bytes, not UTF-16 units", () => {
    // 40k three-byte characters: 40k UTF-16 units, 120KB on the wire. The
    // old length check let this past a 64KB cap.
    const wide = "の".repeat(40_000);
    const capped = capText(wide);
    expect(capped).not.toBe(wide);
    expect(Buffer.byteLength(capped.split("\n")[0] ?? "", "utf8")).toBeLessThanOrEqual(64 * 1024);
    // The cut lands on a character boundary — no replacement characters.
    expect(capped).not.toContain("�");
  });

  it("leaves anything inside the cap alone", () => {
    expect(capText("hello")).toBe("hello");
  });
});

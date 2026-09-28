/**
 * Opening an app-server connection, and the two questions the probe and the
 * model picker ask it.
 *
 * `initialize` comes first on every connection, then the `initialized`
 * notification; the server answers nothing else before it. The client opts
 * into the experimental API from the start — plan mode (`collaborationMode`
 * on `turn/start`) and `item/tool/requestUserInput` exist only behind it —
 * and declines attestation requests, which Poseidon cannot answer. Every
 * recording is made with this exact handshake, so changing it means
 * recording again.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  GetAccountResponse,
  InitializeResponse,
  ModelListResponse,
  type CodexModel,
} from "./protocol";
import { RpcFailed, type RpcClient } from "./rpc";

/** How Poseidon introduces itself; the server folds it into its user agent. */
export const CLIENT_INFO = { name: "poseidon", title: "Poseidon", version: "0.0.0" } as const;

export const INITIALIZE_PARAMS = {
  clientInfo: CLIENT_INFO,
  capabilities: { experimentalApi: true, requestAttestation: false },
} as const;

/** A catalogue longer than this many pages is a server that never stops paging. */
const MAX_MODEL_PAGES = 20;

/** A response decoded through `schema`, a mismatch failing like the request would. */
const call = <A>(
  rpc: RpcClient,
  method: string,
  params: unknown,
  schema: Schema.Decoder<A>,
): Effect.Effect<A, RpcFailed> =>
  rpc
    .request(method, params)
    .pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(schema)(result).pipe(
          Effect.mapError(
            (error) =>
              new RpcFailed({ method, message: `unexpected ${method} response: ${error.message}` }),
          ),
        ),
      ),
    );

/** `initialize`, then `initialized`. */
export const initialize = (rpc: RpcClient): Effect.Effect<InitializeResponse, RpcFailed> =>
  call(rpc, "initialize", INITIALIZE_PARAMS, InitializeResponse).pipe(
    Effect.tap(() => rpc.notify("initialized")),
  );

/** The signed-in account, without asking the server to refresh its token. */
export const readAccount = (rpc: RpcClient): Effect.Effect<GetAccountResponse, RpcFailed> =>
  call(rpc, "account/read", { refreshToken: false }, GetAccountResponse);

/** Every row `model/list` pages out, in the server's order. */
export const readModels = (rpc: RpcClient): Effect.Effect<ReadonlyArray<CodexModel>, RpcFailed> =>
  Effect.gen(function* () {
    const rows: Array<CodexModel> = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const response: ModelListResponse = yield* call(
        rpc,
        "model/list",
        cursor === null ? {} : { cursor },
        ModelListResponse,
      );
      rows.push(...response.data);
      cursor = response.nextCursor;
      if (cursor === null) break;
    }
    return rows;
  });

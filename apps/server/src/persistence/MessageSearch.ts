/**
 * `threads.searchMessages` over the read models: the message index kept by
 * `putThread` (see `MessageIndex`). A failed query reaches the client as a
 * bare `internal` error; the SQL behind it stays in the server's log.
 */

import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MessageSearch } from "../rpc/services";
import { ReadModelStore } from "./ReadModels";

export const layer = Layer.effect(
  MessageSearch,
  Effect.gen(function* () {
    const readModels = yield* ReadModelStore;
    return MessageSearch.of({
      search: (query, limit) =>
        readModels.searchMessages(query, limit).pipe(
          Effect.tapError((error) => Effect.logError("message search failed", error)),
          Effect.mapError(
            () => new PoseidonRpcError({ code: "internal", message: "internal error" }),
          ),
        ),
    });
  }),
);

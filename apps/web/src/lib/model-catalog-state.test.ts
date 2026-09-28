import type { ConnectorModels } from "@poseidon/client-runtime/connectorAtoms";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vitest";

import { emptyPickerText, modelCatalogState } from "./model-catalog-state";

const group = (models: number) =>
  ({
    connector: { connectorInstanceId: "a", displayName: "Comet Cloud" },
    models: Array.from({ length: models }, (_, index) => ({ id: `m${index}`, label: `M${index}` })),
  }) as unknown as ConnectorModels;

describe("modelCatalogState", () => {
  it("is loading until the catalog answers, even though it starts as an empty list", () => {
    expect(modelCatalogState(AsyncResult.initial())).toEqual({ status: "loading" });
    expect(modelCatalogState(AsyncResult.success([], { waiting: true }))).toEqual({
      status: "loading",
    });
  });

  it("is ready once it answers, empty or not, and while refreshing a list it has", () => {
    expect(modelCatalogState(AsyncResult.success([]))).toEqual({ status: "ready" });
    expect(modelCatalogState(AsyncResult.success([group(1)], { waiting: true }))).toEqual({
      status: "ready",
    });
  });

  it("carries a failure's message", () => {
    const failed = AsyncResult.failure<ReadonlyArray<ConnectorModels>, Error>(
      Cause.fail(new Error("socket closed")),
    );
    expect(modelCatalogState(failed)).toEqual({ status: "failed", message: "socket closed" });
  });
});

describe("emptyPickerText", () => {
  const ready = { status: "ready" } as const;

  it("names loading and a failure rather than pointing at Settings", () => {
    expect(emptyPickerText({ status: "loading" }, []).title).toBe("Loading models");
    expect(emptyPickerText({ status: "failed", message: "socket closed" }, [])).toEqual({
      title: "Could not list the harnesses",
      description: "socket closed",
    });
  });

  it("tells no harness, no models and everything switched off apart", () => {
    expect(emptyPickerText(ready, []).title).toBe("No harness enabled");
    expect(emptyPickerText(ready, [group(0)]).description).toContain("listed any models");
    expect(emptyPickerText(ready, [group(0), group(2)]).description).toContain("Settings → Models");
  });
});

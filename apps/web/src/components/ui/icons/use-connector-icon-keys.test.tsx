/**
 * The kind → iconKey map read from the connector descriptors, with the atoms
 * stubbed: every listed kind's key once they load, and an empty map before.
 */

import type { ConnectorDescriptor } from "@poseidon/contracts/connectors";
import { AsyncResult } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { useConnectorIconKeys } from "./use-connector-icon-keys";

const state = vi.hoisted(() => ({ result: undefined as unknown }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.result }));
vi.mock("@/lib/app-runtime", () => ({
  useAppAtoms: () => ({ connectorDescriptorsAtom: {} }),
}));

const descriptor = (kind: string, iconKey: string) =>
  ({
    kind,
    metadata: { displayName: kind, iconKey, accent: "#000000" },
    configFields: [],
  }) as unknown as ConnectorDescriptor;

const keysWhile = (result: unknown): ReadonlyMap<string, string> => {
  state.result = result;
  let keys: ReadonlyMap<string, string> = new Map();
  function Probe() {
    keys = useConnectorIconKeys();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return keys;
};

describe("useConnectorIconKeys", () => {
  it("maps every described kind to its iconKey", () => {
    const keys = keysWhile(
      AsyncResult.success([descriptor("alpha", "claude-code"), descriptor("beta", "terminal")]),
    );
    expect([...keys]).toEqual([
      ["alpha", "claude-code"],
      ["beta", "terminal"],
    ]);
  });

  it("is empty until the descriptors load", () => {
    expect(keysWhile(AsyncResult.initial()).size).toBe(0);
  });
});

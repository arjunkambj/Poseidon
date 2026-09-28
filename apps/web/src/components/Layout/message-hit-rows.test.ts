import type { MessageSearchHit } from "@poseidon/contracts/search";
import { describe, expect, it } from "vitest";

import { messageHitProject, messageHitRows } from "./message-hit-rows";

const projects = [{ projectId: "proj-a", name: "Poseidon" }];

const hit = (overrides: Partial<MessageSearchHit> = {}): MessageSearchHit =>
  ({
    threadId: "t-1",
    projectId: "proj-a",
    title: "Fix login flow",
    archived: false,
    itemId: "i-1",
    role: "assistant",
    snippet: "…the Login token expires before the login redirect…",
    ...overrides,
  }) as MessageSearchHit;

describe("messageHitProject", () => {
  it("names the hit's project", () => {
    expect(messageHitProject(projects, hit())).toBe("Poseidon");
  });

  it("marks an archived hit", () => {
    expect(messageHitProject(projects, hit({ archived: true }))).toBe("Archived · Poseidon");
  });

  it("falls back for a project it does not know", () => {
    const orphan = hit({ projectId: "proj-gone" as MessageSearchHit["projectId"] });
    expect(messageHitProject(projects, orphan)).toBe("Other threads");
    expect(messageHitProject(projects, { ...orphan, archived: true })).toBe(
      "Archived · Other threads",
    );
  });
});

describe("messageHitRows", () => {
  it("keeps the server's order with a value unique to message hits", () => {
    const rows = messageHitRows(
      [hit(), hit({ threadId: "t-2" as MessageSearchHit["threadId"] })],
      projects,
      "login",
    );
    expect(rows.map((row) => row.value)).toEqual(["message t-1", "message t-2"]);
  });

  it("marks every occurrence of the query in the snippet, ignoring case", () => {
    const [row] = messageHitRows([hit()], projects, "login");
    expect(row?.segments).toEqual([
      { text: "…the ", match: false },
      { text: "Login", match: true },
      { text: " token expires before the ", match: false },
      { text: "login", match: true },
      { text: " redirect…", match: false },
    ]);
  });

  it("leaves a snippet without the query unmarked", () => {
    const [row] = messageHitRows([hit({ snippet: "nothing here" })], projects, "login");
    expect(row?.segments).toEqual([{ text: "nothing here", match: false }]);
  });
});

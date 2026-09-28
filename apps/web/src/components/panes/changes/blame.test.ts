import type { GitBlameEntry } from "@poseidon/contracts/git-review";
import { describe, expect, it } from "vitest";

import { blameAge, blameAt, blameCommits } from "./blame";

const entry = (fields: Partial<GitBlameEntry> & Pick<GitBlameEntry, "sha">): GitBlameEntry => ({
  author: "Ada",
  time: "2026-09-01T00:00:00.000Z",
  summary: "a commit",
  uncommitted: false,
  startLine: 1,
  lineCount: 1,
  ...fields,
});

const OLD = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZERO = "0000000000000000000000000000000000000000";

const entries = [
  entry({
    sha: OLD,
    time: "2026-01-01T00:00:00.000Z",
    summary: "first",
    startLine: 1,
    lineCount: 3,
  }),
  entry({
    sha: NEW,
    time: "2026-09-01T00:00:00.000Z",
    summary: "second",
    startLine: 4,
    lineCount: 2,
  }),
  entry({
    sha: ZERO,
    author: "Not committed yet",
    time: "2026-09-28T00:00:00.000Z",
    summary: "",
    uncommitted: true,
    startLine: 6,
    lineCount: 1,
  }),
  entry({
    sha: OLD,
    time: "2026-01-01T00:00:00.000Z",
    summary: "first",
    startLine: 7,
    lineCount: 4,
  }),
];

describe("blameCommits", () => {
  it("groups runs by commit, summing their lines", () => {
    const commits = blameCommits(entries);
    expect(commits.map((commit) => [commit.shortSha, commit.lines])).toEqual([
      ["0000000", 1],
      ["2222222", 2],
      ["1111111", 7],
    ]);
  });

  it("puts the working copy's lines first, then newest first", () => {
    const commits = blameCommits(entries);
    expect(commits[0]?.uncommitted).toBe(true);
    expect(commits.slice(1).map((commit) => commit.summary)).toEqual(["second", "first"]);
  });

  it("is empty for no entries", () => {
    expect(blameCommits([])).toEqual([]);
  });
});

describe("blameAt", () => {
  it("finds the run that covers a line", () => {
    expect(blameAt(entries, 1)?.sha).toBe(OLD);
    expect(blameAt(entries, 5)?.sha).toBe(NEW);
    expect(blameAt(entries, 6)?.uncommitted).toBe(true);
    expect(blameAt(entries, 10)?.sha).toBe(OLD);
  });

  it("is undefined past the blamed lines", () => {
    expect(blameAt(entries, 11)).toBeUndefined();
  });
});

describe("blameAge", () => {
  const now = Date.parse("2026-09-28T12:00:00.000Z");

  it("reads as how long ago", () => {
    expect(blameAge(now, "2026-09-28T11:59:30.000Z")).toBe("just now");
    expect(blameAge(now, "2026-09-28T11:55:00.000Z")).toBe("5m ago");
    expect(blameAge(now, "2026-09-25T12:00:00.000Z")).toBe("3d ago");
  });

  it("names the month past a year, and nothing for a bad time", () => {
    expect(blameAge(now, "2024-03-10T12:00:00.000Z")).toBe("Mar 2024");
    expect(blameAge(now, "not a time")).toBe("");
  });
});

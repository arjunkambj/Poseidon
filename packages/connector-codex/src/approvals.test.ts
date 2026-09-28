/**
 * The app-server's approval requests in Poseidon's approval vocabulary: the
 * kind the ladder reads, its input, the pattern "allow always" proposes and
 * the card's line. The recorded requests are the CLI's own; every pattern is
 * checked against the shared parser, so a suggestion is always one the
 * settings page can save.
 */

import { parsePattern } from "@poseidon/shared/permissionPattern";
import { describe, expect, it } from "vitest";

import { recordedNotifications, recordedServerRequests } from "../test/frames";
import {
  COMMAND_APPROVAL,
  commandApprovalRequest,
  FILE_CHANGE_APPROVAL,
  fileChangeApprovalRequests,
  makeFileChangePaths,
  pathsOfChanges,
  shellPattern,
  unwrapShell,
} from "./approvals";

const requestOf = (scenario: string, method: string, launch = 0) => {
  const found = recordedServerRequests(scenario, launch).find((each) => each.method === method);
  if (found === undefined) throw new Error(`${scenario} has no ${method}`);
  return found;
};

describe("unwrapShell", () => {
  it.each([
    ["/bin/zsh -lc 'touch denied.txt'", "touch denied.txt"],
    ["/bin/zsh -lc \"printf 'ok' > conformance.txt\"", "printf 'ok' > conformance.txt"],
    ["/bin/zsh -lc ls", "ls"],
    ["bash -c 'npm run test'", "npm run test"],
    ["npm run test", "npm run test"],
    ["  git status  ", "git status"],
  ])("%s → %s", (wrapped, script) => {
    expect(unwrapShell(wrapped)).toBe(script);
  });
});

describe("a command approval", () => {
  it("reads the recorded request as a Shell command, unwrapped, with its cwd", () => {
    const request = commandApprovalRequest(requestOf("deny", COMMAND_APPROVAL).params);
    expect(request.kind).toBe("command");
    expect(request.toolName).toBe("Shell");
    expect(request.input).toEqual({ command: "touch denied.txt", cwd: "<SCRATCH>/deny" });
    expect(request.patternSuggestion).toBe("Shell(touch *)");
    expect(request.description).toBe("Run touch denied.txt");
    expect(parsePattern(request.patternSuggestion!)).toMatchObject({ family: "shell" });
  });

  it("hands the ladder the path of a sensitive read as a command argument", () => {
    const params = requestOf("sensitive-full-access", COMMAND_APPROVAL).params;
    const request = commandApprovalRequest(params);
    expect(request.input).toMatchObject({ command: "cat .env" });
    expect(request.patternSuggestion).toBe("Shell(cat *)");
  });

  it("says why, and what a terminal write is, and never proposes an unparseable pattern", () => {
    expect(
      commandApprovalRequest({ command: "curl example.com", reason: "needs network" }).description,
    ).toBe("Run curl example.com — needs network");
    const stdin = commandApprovalRequest({ kind: "writeStdin" });
    expect(stdin.description).toBe("Write to the running command's terminal");
    expect(stdin.input).toEqual({});
    expect(stdin.patternSuggestion).toBe("Shell(*)");
    for (const command of [undefined, "", "   ", "npm run *"]) {
      expect(parsePattern(shellPattern(command))).not.toBeNull();
    }
  });

  it("gives every card an id of its own", () => {
    const params = requestOf("deny", COMMAND_APPROVAL).params;
    expect(commandApprovalRequest(params).requestId).not.toBe(
      commandApprovalRequest(params).requestId,
    );
  });
});

describe("a file-change approval", () => {
  it("names the path the item's item/started gave, as an Edit of that file", () => {
    const paths = makeFileChangePaths();
    for (const notification of recordedNotifications("edit-approval")) {
      paths.observe(notification.method, notification.params);
    }
    const params = requestOf("edit-approval", FILE_CHANGE_APPROVAL).params;
    const [request, ...rest] = fileChangeApprovalRequests(params, paths.pathsOf);
    expect(rest).toEqual([]);
    expect(request!.kind).toBe("file_write");
    expect(request!.toolName).toBe("Edit");
    expect(request!.input).toEqual({ file_path: "<SCRATCH>/edit-approval/hello.txt" });
    expect(request!.patternSuggestion).toBe("Edit(<SCRATCH>/edit-approval/hello.txt)");
    expect(request!.description).toBe("Edit <SCRATCH>/edit-approval/hello.txt");
    expect(parsePattern(request!.patternSuggestion!)).toMatchObject({ family: "edit" });
  });

  it("is one request per path, a move's destination included", () => {
    const changes = [
      { path: "/r/a.ts", kind: { type: "update", move_path: "/r/b.ts" } },
      { path: "/r/.env", kind: { type: "add" } },
      { path: "/r/a.ts", kind: { type: "update", move_path: null } },
    ];
    expect(pathsOfChanges(changes)).toEqual(["/r/a.ts", "/r/b.ts", "/r/.env"]);
    const paths = makeFileChangePaths();
    paths.observe("item/started", { item: { type: "fileChange", id: "i1", changes } });
    const requests = fileChangeApprovalRequests({ itemId: "i1" }, paths.pathsOf);
    expect(requests.map((request) => request.input)).toEqual([
      { file_path: "/r/a.ts" },
      { file_path: "/r/b.ts" },
      { file_path: "/r/.env" },
    ]);
    paths.clear();
    expect(paths.pathsOf("i1")).toBeUndefined();
  });

  it("falls back to the root the CLI asked for, or no path, for an item it never saw", () => {
    const none = () => undefined;
    const [rooted] = fileChangeApprovalRequests({ itemId: "x", grantRoot: "/r/out" }, none);
    expect(rooted!.input).toEqual({ file_path: "/r/out" });
    const [bare] = fileChangeApprovalRequests({ itemId: "x", reason: "extra room" }, none);
    expect(bare!.input).toEqual({});
    expect(bare!.patternSuggestion).toBe("Edit(*)");
    expect(bare!.description).toBe("Change files — extra room");
    expect(parsePattern(bare!.patternSuggestion!)).not.toBeNull();
  });

  it("ignores items that are not file changes", () => {
    const paths = makeFileChangePaths();
    paths.observe("item/started", { item: { type: "commandExecution", id: "c1" } });
    paths.observe("turn/started", { item: { type: "fileChange", id: "f1", changes: [] } });
    expect(paths.pathsOf("c1")).toBeUndefined();
    expect(paths.pathsOf("f1")).toBeUndefined();
  });
});

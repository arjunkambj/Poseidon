/**
 * The worktree notice: a worktree that could not start from origin is
 * announced in a toast, and the `ThreadWorktree` handed on to `thread.create`
 * carries no `notice`. Run over the real git commands with a stubbed client,
 * wired the way `git-atoms.ts` wires them.
 */

import { makeRuntime } from "@poseidon/client-runtime/atoms";
import {
  Connection,
  ConnectionStateRef,
  type ConnectionState,
  type PoseidonRpcClient,
} from "@poseidon/client-runtime/connection";
import { makeGitAtoms } from "@poseidon/client-runtime/gitAtoms";
import { makeGitCommands } from "@poseidon/client-runtime/gitCommands";
import { makeProjectId } from "@poseidon/contracts/ids";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vitest";

const warnings = vi.hoisted(() => [] as Array<string>);
vi.mock("sonner", () => ({ toast: { warning: (message: string) => warnings.push(message) } }));

import { showWorktreeNotice } from "./git-atoms";

const NOTICE = "origin has no main, so the worktree starts from your local main.";
const WORKTREE = { path: "/home/me/.poseidon/worktrees/app/fix", branch: "poseidon/fix" };

const client = (notice: string | undefined): PoseidonRpcClient =>
  new Proxy({} as PoseidonRpcClient, {
    get: (_target, key) => {
      switch (key) {
        case "git.worktree.create":
          return () =>
            Effect.succeed({
              ...WORKTREE,
              baseBranch: "main",
              ...(notice === undefined ? {} : { notice }),
            });
        case "git.branches":
          return () =>
            Effect.succeed({
              isRepository: true,
              current: "main",
              defaultBranch: "main",
              remotes: [],
              branches: [],
            });
        default:
          return () => Effect.die(`unimplemented rpc ${String(key)}`);
      }
    },
  });

const create = async (notice: string | undefined) => {
  const state = await Effect.runPromise(
    SubscriptionRef.make<ConnectionState>({ status: "connected", serverInstanceId: null }),
  );
  const { runtime } = makeRuntime(
    Layer.mergeAll(
      Layer.succeed(Connection, { client: Effect.succeed(client(notice)), state }),
      Layer.succeed(ConnectionStateRef, state),
    ),
  );
  const commands = makeGitCommands(runtime, makeGitAtoms(runtime), {
    onWorktreeNotice: showWorktreeNotice,
  });
  return commands.worktreeCreate(AtomRegistry.make(), {
    projectId: makeProjectId(),
    name: "Fix it",
  });
};

describe("the worktree notice", () => {
  beforeEach(() => {
    warnings.length = 0;
  });

  it("toasts the notice and hands on the worktree without it", async () => {
    const exit = await create(NOTICE);
    expect(warnings).toEqual([NOTICE]);
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ ...WORKTREE, baseBranch: "main" });
    expect(Exit.isSuccess(exit) && "notice" in exit.value).toBe(false);
  });

  it("says nothing when the worktree started where it was asked to", async () => {
    const exit = await create(undefined);
    expect(warnings).toEqual([]);
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

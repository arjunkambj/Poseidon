/**
 * The link provider over a fake xterm buffer: a line's candidates go out in
 * one `resolve` call, answers are kept, only files become links, the ranges
 * land on the right cells (past a wide character too), and a failed call is
 * asked again.
 */

import type { FileStat } from "@poseidon/contracts/rpc";
import type { IBufferLine, ILink, ILinkProvider } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";

import { registerFileLinks } from "./file-link-provider";

/** One row of cells: a wide character takes its cell and an empty one after it. */
const row = (text: string): IBufferLine => {
  const cells: Array<{ chars: string; width: number }> = [];
  for (const char of text) {
    const wide = /\p{Script=Han}/u.test(char);
    cells.push({ chars: char, width: wide ? 2 : 1 });
    if (wide) cells.push({ chars: "", width: 0 });
  }
  return {
    isWrapped: false,
    length: cells.length,
    getCell: (x: number) => {
      const cell = cells[x];
      return cell === undefined
        ? undefined
        : ({ getChars: () => cell.chars, getWidth: () => cell.width } as never);
    },
    translateToString: () => text,
  } as IBufferLine;
};

const fakeTerminal = (lines: ReadonlyArray<string>) => {
  let provider: ILinkProvider | null = null;
  const disposeProvider = vi.fn();
  const terminal = {
    buffer: {
      active: { getLine: (y: number) => (lines[y] === undefined ? undefined : row(lines[y])) },
    },
    registerLinkProvider: (next: ILinkProvider) => {
      provider = next;
      return { dispose: disposeProvider };
    },
  };
  const links = (y: number) =>
    new Promise<ReadonlyArray<ILink> | undefined>((resolve) => provider?.provideLinks(y, resolve));
  return { terminal: terminal as never, links, disposeProvider };
};

const stat = (path: string, isDirectory = false): FileStat => ({
  path,
  relativePath: path.replace(/^\/repo\//, ""),
  absolutePath: path.startsWith("/") ? path : `/repo/${path}`,
  isDirectory,
});

describe("registerFileLinks", () => {
  it("links only confirmed files, on the cells the reference covers", async () => {
    const { terminal, links } = fakeTerminal(["漢 src/a.ts:12:3 src/dir/x.ts:1 gone/b.ts:2"]);
    const resolve = vi.fn(async (paths: ReadonlyArray<string>) =>
      paths.includes("src/a.ts") ? [stat("src/a.ts"), stat("src/dir/x.ts", true)] : [],
    );
    const activate = vi.fn();
    registerFileLinks(terminal, { resolve, activate });

    const found = await links(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(["src/a.ts", "src/dir/x.ts", "gone/b.ts"]);
    expect(found?.map((link) => [link.text, link.range])).toEqual([
      ["src/a.ts", { start: { x: 4, y: 1 }, end: { x: 16, y: 1 } }],
    ]);

    const event = { metaKey: true } as MouseEvent;
    found?.[0]?.activate(event, "src/a.ts");
    expect(activate).toHaveBeenCalledWith(
      stat("src/a.ts"),
      expect.objectContaining({ path: "src/a.ts", line: 12, column: 3 }),
      event,
    );
  });

  it("keeps its answers, found or not, and asks only about new paths", async () => {
    const { terminal, links } = fakeTerminal(["src/a.ts:1 nope/b.ts:2", "nope/b.ts:3 src/c.ts:4"]);
    const resolve = vi.fn(async (paths: ReadonlyArray<string>) =>
      paths.filter((path) => path.startsWith("src/")).map((path) => stat(path)),
    );
    registerFileLinks(terminal, { resolve, activate: vi.fn() });

    expect((await links(1))?.map((link) => link.text)).toEqual(["src/a.ts"]);
    expect((await links(1))?.map((link) => link.text)).toEqual(["src/a.ts"]);
    expect((await links(2))?.map((link) => link.text)).toEqual(["src/c.ts"]);
    expect(resolve.mock.calls).toEqual([[["src/a.ts", "nope/b.ts"]], [["src/c.ts"]]]);
  });

  it("gives no links for a line with no references, and never asks for it", async () => {
    const { terminal, links } = fakeTerminal([
      "just output at 12:30:45 http://localhost:3000/a.ts:1",
    ]);
    const resolve = vi.fn(async () => []);
    registerFileLinks(terminal, { resolve, activate: vi.fn() });
    expect(await links(1)).toBeUndefined();
    expect(await links(9)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("asks again after a failed call, and disposes its provider", async () => {
    const { terminal, links, disposeProvider } = fakeTerminal(["src/a.ts:1"]);
    const resolve = vi
      .fn<(paths: ReadonlyArray<string>) => Promise<ReadonlyArray<FileStat>>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([stat("src/a.ts")]);
    const registration = registerFileLinks(terminal, { resolve, activate: vi.fn() });

    expect(await links(1)).toBeUndefined();
    expect((await links(1))?.map((link) => link.text)).toEqual(["src/a.ts"]);
    expect(resolve).toHaveBeenCalledTimes(2);

    registration.dispose();
    expect(disposeProvider).toHaveBeenCalledTimes(1);
  });
});

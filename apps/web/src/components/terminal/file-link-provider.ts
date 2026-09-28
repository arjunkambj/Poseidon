/**
 * The xterm half of the terminal's file links: a link provider that turns the
 * `path:line[:col]` references a line prints (`./file-links`) into links, but
 * only once `files.stat` has confirmed each one names a file inside the
 * workspace — a directory, a missing path or one outside the root stays text.
 *
 * xterm asks for a line's links as the pointer reaches it. The references on
 * that line whose answer is not known yet go out in one `resolve` call, and
 * every answer, found or not, is kept for the provider's life, so moving back
 * over a line asks nothing. A failed call keeps nothing and is asked again on
 * the next hover. A file created after its path was first hovered therefore
 * links only once the terminal is next mounted.
 *
 * Known limit: a reference is read from one buffer row, so one the terminal
 * wrapped across two rows is not a link.
 */

import { FILES_STAT_MAX_PATHS, type FileStat } from "@poseidon/contracts/rpc";
import type { IBufferLine, IDisposable, ILink, Terminal } from "@xterm/xterm";

import { findFileReferences, type FileReference } from "@/components/terminal/file-links";

export interface FileLinkHandlers {
  /** Which of `paths` exist; rejects when the question could not be asked. */
  readonly resolve: (paths: ReadonlyArray<string>) => Promise<ReadonlyArray<FileStat>>;
  /** A confirmed link was clicked. */
  readonly activate: (stat: FileStat, reference: FileReference, event: MouseEvent) => void;
}

/**
 * The 0-based cell each UTF-16 offset of `translateToString(true)` falls in. A
 * wide character's trailing cell adds no text, and an empty cell reads as one
 * space, the same way xterm builds the string.
 */
const cellOffsets = (line: IBufferLine): ReadonlyArray<number> => {
  const cells: Array<number> = [];
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    if (cell === undefined) break;
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    for (let unit = 0; unit < chars.length; unit += 1) cells.push(x);
  }
  return cells;
};

/** Registers the provider on `terminal`; dispose it with the terminal. */
export const registerFileLinks = (
  terminal: Pick<Terminal, "registerLinkProvider" | "buffer">,
  handlers: FileLinkHandlers,
): IDisposable => {
  const answers = new Map<string, FileStat | null>();
  let disposed = false;

  const linksOn = (
    y: number,
    cells: ReadonlyArray<number>,
    references: ReadonlyArray<FileReference>,
  ): Array<ILink> => {
    const links: Array<ILink> = [];
    for (const reference of references) {
      const stat = answers.get(reference.path);
      const first = cells[reference.start];
      const last = cells[reference.end - 1];
      if (stat == null || first === undefined || last === undefined) continue;
      links.push({
        range: { start: { x: first + 1, y }, end: { x: last + 1, y } },
        text: reference.path,
        activate: (event) => handlers.activate(stat, reference, event),
      });
    }
    return links;
  };

  const provider = terminal.registerLinkProvider({
    provideLinks: (y, callback) => {
      const line = terminal.buffer.active.getLine(y - 1);
      const references = line === undefined ? [] : findFileReferences(line.translateToString(true));
      if (line === undefined || references.length === 0) {
        callback(undefined);
        return;
      }
      // Read now: the row may have scrolled on by the time `resolve` answers.
      const cells = cellOffsets(line);
      const unknown = [...new Set(references.map((reference) => reference.path))]
        .filter((path) => !answers.has(path))
        .slice(0, FILES_STAT_MAX_PATHS);
      const answer = (): void => {
        if (disposed) return;
        const links = linksOn(y, cells, references);
        callback(links.length === 0 ? undefined : links);
      };
      if (unknown.length === 0) {
        answer();
        return;
      }
      handlers.resolve(unknown).then(
        (stats) => {
          for (const path of unknown) answers.set(path, null);
          for (const stat of stats) {
            if (!stat.isDirectory) answers.set(stat.path, stat);
          }
          answer();
        },
        () => {
          if (!disposed) callback(undefined);
        },
      );
    },
  });

  return {
    dispose: () => {
      disposed = true;
      provider.dispose();
    },
  };
};

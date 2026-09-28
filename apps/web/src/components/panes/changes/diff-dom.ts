/**
 * Reads where the Changes list's files and their changed lines sit, off the
 * rendered page, for the change keys and the scrollbar marks.
 *
 * `@pierre/diffs` renders each patch into a `diffs-container` element
 * (`DIFFS_TAG_NAME`) with the lines inside its shadow root, so a query from
 * the list never sees them; this asks each container's shadow root instead.
 * A changed line is a `[data-line]` element whose `data-line-type` is
 * `change-addition` or `change-deletion` — the gutter's line numbers carry the
 * same type but no `data-line`, so they are left out. In split view both
 * columns render rows, which `changeBlocks` folds together by height.
 *
 * A closed file renders no container, so it costs one rect and an empty query.
 */

import { DIFFS_TAG_NAME } from "@pierre/diffs";

import { type ChangeRow, type SectionChanges, changeBlocks } from "./change-blocks";

const CHANGE_ROWS =
  '[data-line][data-line-type="change-addition"], [data-line][data-line-type="change-deletion"]';

/**
 * One file of the list, in px from the top of the list's content, with its
 * changed lines in blocks, top to bottom — none while it is closed.
 */
export interface SectionLayout extends SectionChanges {
  readonly bottom: number;
}

const readChangeRows = (section: Element, origin: number): ReadonlyArray<ChangeRow> => {
  const rows: Array<ChangeRow> = [];
  for (const host of section.querySelectorAll(DIFFS_TAG_NAME)) {
    for (const line of host.shadowRoot?.querySelectorAll(CHANGE_ROWS) ?? []) {
      const type = line.getAttribute("data-line-type");
      const rect = line.getBoundingClientRect();
      if ((type === "change-addition" || type === "change-deletion") && rect.height > 0) {
        rows.push({ top: rect.top - origin, bottom: rect.bottom - origin, type });
      }
    }
  }
  return rows;
};

/** Every file of the list `content` holds — one `<section>` per file, in file order. */
export const readSections = (content: Element): ReadonlyArray<SectionLayout> => {
  const origin = content.getBoundingClientRect().top;
  return [...content.children].map((section) => {
    const rect = section.getBoundingClientRect();
    return {
      top: rect.top - origin,
      bottom: rect.bottom - origin,
      header: section.firstElementChild?.getBoundingClientRect().height ?? 0,
      blocks: changeBlocks(readChangeRows(section, origin)),
    };
  });
};

/**
 * The Changes list as laid out: where each file and each of its change blocks
 * sits (`readSections`), how tall the content and the view are, and how wide
 * the scroller's own scrollbar is. Read again whenever the content or the
 * view changes size — a file opening, its patch rendering, split view, the
 * dock resizing — at most once a frame, and when `key` changes.
 */

import * as React from "react";

import { type SectionLayout, readSections } from "./diff-dom";

export interface ReviewLayout {
  readonly sections: ReadonlyArray<SectionLayout>;
  readonly contentHeight: number;
  /** The scroller's visible height. */
  readonly viewHeight: number;
  /** How wide a scrollbar that takes up room is; `0` for an overlay one. */
  readonly scrollbar: number;
}

const EMPTY: ReviewLayout = { sections: [], contentHeight: 0, viewHeight: 0, scrollbar: 0 };

export function useReviewLayout(
  scrollerRef: React.RefObject<HTMLElement | null>,
  contentRef: React.RefObject<HTMLElement | null>,
  key: unknown,
): ReviewLayout {
  const [layout, setLayout] = React.useState(EMPTY);
  React.useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (scroller === null || content === null) {
      return;
    }
    let frame = 0;
    let last = "";
    const measure = () => {
      frame = 0;
      const next: ReviewLayout = {
        sections: readSections(content),
        contentHeight: content.getBoundingClientRect().height,
        viewHeight: scroller.clientHeight,
        scrollbar: scroller.offsetWidth - scroller.clientWidth,
      };
      // A resize that moved nothing (a highlight pass) re-renders nothing.
      const signature = JSON.stringify(next);
      if (signature !== last) {
        last = signature;
        setLayout(next);
      }
    };
    const schedule = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(measure);
      }
    };
    schedule();
    const sizes = new ResizeObserver(schedule);
    sizes.observe(content);
    sizes.observe(scroller);
    return () => {
      sizes.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scrollerRef, contentRef, key]);
  return layout;
}

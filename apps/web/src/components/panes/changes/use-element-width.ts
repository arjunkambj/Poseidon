/**
 * An element's width in px, kept current with a `ResizeObserver` — measured
 * before the first paint, so a layout that depends on it never flashes the
 * wrong way. `0` until the element is laid out.
 */

import * as React from "react";

export function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const update = () => setWidth(element.getBoundingClientRect().width);
    update();
    const sizes = new ResizeObserver(update);
    sizes.observe(element);
    return () => sizes.disconnect();
  }, [ref]);
  return width;
}

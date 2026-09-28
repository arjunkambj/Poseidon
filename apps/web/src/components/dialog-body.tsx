/**
 * The scrolling middle of a dialog. A long body scrolls inside it while the
 * header and the footer stay put. It runs edge to edge (`-mx-4 px-4`), so the
 * scrollbar sits on the dialog's edge rather than beside the content, and
 * `-my-2 py-2` leaves room at its top and bottom edges for a focus ring and
 * for a checkbox's hit area, which reaches 8px past the box and would
 * otherwise make the body scroll by a few pixels.
 *
 * The body's own cap cannot see the header and footer around it, so a dialog
 * that holds a DialogBody also puts `max-h-[calc(100dvh-2rem)] overflow-y-auto`
 * on its DialogContent: in a window too short for header, body and footer
 * together, the whole popup scrolls and its footer actions stay reachable.
 */
import type * as React from "react";

import { cn } from "@poseidon/ui/lib/utils";

export function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("-mx-4 -my-2 max-h-[60vh] min-h-0 overflow-y-auto px-4 py-2", className)}
      {...props}
    />
  );
}

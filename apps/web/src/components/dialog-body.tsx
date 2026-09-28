/**
 * The scrolling middle of a dialog. A long body scrolls inside it while the
 * header and the footer stay put. It runs edge to edge (`-mx-4 px-4`), so the
 * scrollbar sits on the dialog's edge rather than beside the content, and
 * `-my-1 py-1` leaves room for a focus ring at its top and bottom edges.
 */
import type * as React from "react";

import { cn } from "@poseidon/ui/lib/utils";

export function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("-mx-4 -my-1 max-h-[60vh] min-h-0 overflow-y-auto px-4 py-1", className)}
      {...props}
    />
  );
}

/**
 * A dialog's footer under one hairline. The stock `DialogFooter` is already
 * the tonal band; this puts a `Separator` flush on its top edge, so the
 * actions read as their own strip below a scrolling body. The wrapper takes
 * over the footer's edge-to-edge margins, and the footer fills it.
 */
import type * as React from "react";

import { DialogFooter } from "@poseidon/ui/components/dialog";
import { Separator } from "@poseidon/ui/components/separator";

export function DialogActions(props: Omit<React.ComponentProps<typeof DialogFooter>, "className">) {
  return (
    <div data-slot="dialog-actions" className="-mx-4 -mb-4 flex flex-col">
      <Separator />
      <DialogFooter className="mx-0 mb-0" {...props} />
    </div>
  );
}

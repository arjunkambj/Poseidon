/**
 * The line above the composer while a sent message is being edited: what
 * sending will undo and what stays (`editCopy`), with Cancel, which ends the
 * edit and leaves the text where it is. Once the server has taken the
 * restore it says so until the restore settles, and then goes. It also hosts
 * the confirmation (`./edit-resend-dialog`), which only a plain send opens.
 */

import { Alert, AlertAction, AlertDescription } from "@poseidon/ui/components/alert";
import { Button } from "@poseidon/ui/components/button";

import { EditResendDialog } from "@/components/composer/edit-resend-dialog";
import type { EditResend } from "@/components/composer/use-edit-resend";
import { Edit, Spinner } from "@honeyicons/react";

export function EditBanner({ editResend }: { readonly editResend: EditResend }) {
  const { copy, restoring } = editResend;
  if (copy === null) {
    return null;
  }
  return (
    <>
      <Alert role="status" className="w-full">
        {restoring ? <Spinner variant="bold" /> : <Edit variant="bold" />}
        <AlertDescription>
          {restoring
            ? "Restoring the workspace… The edited message is sent once it is back."
            : copy.attachmentsNote === null
              ? copy.summary
              : `${copy.summary} ${copy.attachmentsNote}`}
        </AlertDescription>
        {restoring ? null : (
          <AlertAction>
            <Button type="button" variant="outline" size="xs" onClick={editResend.cancel}>
              Cancel
            </Button>
          </AlertAction>
        )}
      </Alert>
      <EditResendDialog copy={copy} dialog={editResend.dialog} />
    </>
  );
}

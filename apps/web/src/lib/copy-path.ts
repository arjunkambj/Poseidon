/**
 * Copies text to the clipboard and says whether it worked, the same way
 * everywhere a menu offers it: `copyText` names what it copied ("Copied the
 * branch"), and `copyPath` is that for a path — the Changes file menu and a
 * timeline file chip's context menu. The sidebar's thread menu copies a
 * thread's path, branch and id through `copyText`. A clipboard the page cannot
 * reach counts as a failure.
 */

import { toast } from "sonner";

type Clipboard = Pick<globalThis.Clipboard, "writeText">;

const pageClipboard = (): Clipboard | undefined =>
  typeof navigator === "undefined" ? undefined : navigator.clipboard;

export const copyText = (
  text: string,
  what: string,
  clipboard: Clipboard | undefined = pageClipboard(),
): Promise<void> =>
  (clipboard === undefined
    ? Promise.reject(new Error("No clipboard"))
    : clipboard.writeText(text)
  ).then(
    () => {
      toast.success(`Copied the ${what}`);
    },
    () => {
      toast.error(`Could not copy the ${what}`);
    },
  );

export const copyPath = (
  path: string,
  clipboard: Clipboard | undefined = pageClipboard(),
): Promise<void> => copyText(path, "path", clipboard);

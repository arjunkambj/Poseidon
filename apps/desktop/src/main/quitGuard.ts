/**
 * Asking before a quit drops live work.
 *
 * While the renderer reports threads running or waiting on the user, the
 * first quit is held (`preventDefault`) and the window is asked to confirm
 * it; the user's answer either quits for real or clears the hold. A second
 * quit while the question is open goes straight through, the same escape
 * hatch `quit.ts` keeps for a wedged server.
 *
 * It runs *before* `makeQuitHandler` in one `before-quit` listener
 * (`main/index.ts`), so an allowed quit still takes the graceful server
 * shutdown exactly as before. Electron-free so it is unit-testable.
 */

import type { QuitEvent } from "./quit";

export interface QuitGuardDeps {
  /** The renderer's last reported count of running or waiting threads. */
  readonly busyCount: () => number;
  /**
   * Sends the quit request to a live window and brings it forward. False
   * when there is no window to ask, and the quit then goes through.
   */
  readonly ask: () => boolean;
  /** `app.quit()`, for a confirmed quit. */
  readonly quit: () => void;
}

export const makeQuitGuard = (deps: QuitGuardDeps) => {
  let pending = false;
  let confirmed = false;
  return {
    /** True when the quit was held; the caller then does nothing else. */
    onBeforeQuit: (event: QuitEvent): boolean => {
      if (confirmed) return false;
      if (pending) {
        // Quitting again while asked: the user means it.
        pending = false;
        confirmed = true;
        return false;
      }
      if (deps.busyCount() <= 0) return false;
      if (!deps.ask()) return false;
      event.preventDefault();
      pending = true;
      return true;
    },
    /** The window's answer to the held quit. */
    answer: (quit: boolean) => {
      if (!pending) return;
      pending = false;
      if (!quit) return;
      confirmed = true;
      deps.quit();
    },
  };
};

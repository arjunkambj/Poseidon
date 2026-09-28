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

export interface WindowCloseState {
  /** Whether closing the last window quits the app (not on macOS). */
  readonly quitsOnLastClose: boolean;
  /** Whether a quit is already under way, past the guard. */
  readonly quitting: boolean;
  /** Live windows other than the one closing. */
  readonly otherWindows: number;
  /** The renderer's last reported count of running or waiting threads. */
  readonly busy: number;
}

/**
 * Whether a window's close should be held and turned into a quit. On Windows
 * and Linux closing the last window quits, but only once the window is gone,
 * when there is nobody left to ask; so while threads are busy that close is
 * held and becomes an ordinary quit, which the guard above can ask about. A
 * close that is part of a quit already under way is never held, or it would
 * cancel that quit.
 */
export const holdsWindowClose = (state: WindowCloseState): boolean =>
  state.quitsOnLastClose && !state.quitting && state.otherWindows === 0 && state.busy > 0;

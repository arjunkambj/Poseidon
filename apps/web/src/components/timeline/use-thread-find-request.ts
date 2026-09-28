/**
 * Takes a find request (`lib/thread-find-request.ts`) for the thread on
 * screen: when the timeline mounts, when it switches to another thread, and
 * whenever a request is made while it is showing that thread.
 *
 * Declared after `useThreadFind`'s reset on a thread change, whose cleanup runs
 * before this effect, so the request lands on a bar that has just been closed.
 */

import * as React from "react";

import {
  onThreadFindRequest,
  takeThreadFind,
  type ThreadFindRequest,
} from "@/lib/thread-find-request";

export function useThreadFindRequest(
  threadId: string,
  onRequest: (request: ThreadFindRequest) => void,
): void {
  const onRequestRef = React.useRef(onRequest);
  onRequestRef.current = onRequest;
  React.useEffect(() => {
    const claim = () => {
      const request = takeThreadFind(threadId);
      if (request !== null) {
        onRequestRef.current(request);
      }
    };
    claim();
    return onThreadFindRequest(claim);
  }, [threadId]);
}

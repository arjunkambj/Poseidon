import type { ThreadId } from "@poseidon/contracts/ids";
import type * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { RowStatus } from "./session-import-list";

const threadId = "0199c0de-0002-7000-8000-000000000001" as ThreadId;

describe("RowStatus", () => {
  it("runs onOpen as an imported row's Open is followed, so a dialog can close", () => {
    const onOpen = vi.fn();
    const open = RowStatus({
      state: { status: "imported", threadId },
      title: "Alpha README",
      onRetry: () => {},
      onOpen,
    }) as React.ReactElement<{ onClick?: () => void; render?: React.ReactElement }>;
    // A link to the thread, whose click also tells the page holding the list.
    const link = open.props.render as React.ReactElement<{ params?: unknown }>;
    expect(link.props.params).toEqual({ threadId });
    open.props.onClick?.();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

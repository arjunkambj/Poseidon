import type { ItemKind } from "@poseidon/contracts/enums";
import type { ItemId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import type { TimelineRow } from "./fold";
import {
  bulkFoldKeepsEnd,
  foldsOpened,
  INITIAL_SEND_ANCHOR,
  initialSendAnchor,
  isScrollKey,
  pickViewAnchor,
  rowIdSet,
  sendAnchorProps,
  sendAnchorReducer,
  sentUserMessageId,
  type SendAnchorEvent,
  type SendAnchorState,
  viewAnchors,
} from "./send-anchor";

const row = (id: string, kind: ItemKind = "assistant_message"): TimelineRow => ({
  kind: "item",
  id,
  item: { itemId: id as ItemId, kind, status: "completed" },
});
const user = (id: string) => row(id, "user_message");
const working: TimelineRow = { kind: "working", id: "working", startedAt: undefined };

const run = (events: ReadonlyArray<SendAnchorEvent>, from = INITIAL_SEND_ANCHOR) =>
  events.reduce(sendAnchorReducer, from);

const send = (id: string, sentHere = true, awayFromEnd = false): SendAnchorEvent => ({
  type: "rowsChanged",
  newUserMessageId: id,
  turnActive: true,
  sentHere,
  awayFromEnd,
});

const anchored: SendAnchorState = run([send("u2")]);

describe("sentUserMessageId", () => {
  const history = [user("u1"), row("a1")];

  it("never anchors on the first projection", () => {
    expect(sentUserMessageId(null, history)).toBeNull();
  });

  it("finds a user message appended after mount", () => {
    const next = [...history, user("u2"), working];
    expect(sentUserMessageId(rowIdSet(history), next)).toBe("u2");
  });

  it("ignores rows that are not a new latest user message", () => {
    expect(sentUserMessageId(rowIdSet(history), [...history, row("a2")])).toBeNull();
    expect(sentUserMessageId(rowIdSet(history), history)).toBeNull();
    // A fold opening brings rows back, never a user message that is not the latest.
    const opened = [user("u0"), ...history];
    expect(sentUserMessageId(rowIdSet(history), opened)).toBeNull();
  });
});

describe("foldsOpened", () => {
  const folds = (...ids: string[]) => new Set(ids);

  it("is true when a fold opened", () => {
    expect(foldsOpened(folds(), folds("turn-fold:u1"))).toBe(true);
    expect(foldsOpened(folds("turn-fold:u1"), folds("turn-fold:u1", "turn-fold:u2"))).toBe(true);
  });

  it("is false when folds only closed or stayed", () => {
    expect(foldsOpened(folds("turn-fold:u1"), folds())).toBe(false);
    expect(foldsOpened(folds("turn-fold:u1"), folds("turn-fold:u1"))).toBe(false);
  });
});

describe("sendAnchorReducer", () => {
  it("starts following the end, with no reserve", () => {
    expect(sendAnchorProps(INITIAL_SEND_ANCHOR)).toEqual({
      maintainScrollAtEnd: true,
      anchorRowId: null,
      reserveRowId: null,
    });
  });

  it("does not anchor on rows that carry no send", () => {
    const state = run([{ type: "rowsChanged", turnActive: true }]);
    expect(state).toBe(INITIAL_SEND_ANCHOR);
  });

  it("does not anchor on a new user message outside a turn", () => {
    const state = run([{ type: "rowsChanged", newUserMessageId: "u2", turnActive: false }]);
    expect(state).toBe(INITIAL_SEND_ANCHOR);
  });

  it("anchors a send: stops following and holds the message", () => {
    expect(anchored.mode).toBe("anchored");
    expect(sendAnchorProps(anchored)).toEqual({
      maintainScrollAtEnd: false,
      anchorRowId: "u2",
      reserveRowId: "u2",
    });
  });

  it("anchors a send made here from any mode, placing the message again", () => {
    const free = run([{ type: "userScrollIntent" }], anchored);
    const again = run([send("u3")], free);
    expect(again.mode).toBe("anchored");
    expect(again.sentRowId).toBe("u3");
    expect(again.placement).toBe(anchored.placement + 1);
  });

  it("leaves a reader who scrolled away alone for a message this window did not just send", () => {
    // A queued message drained minutes later, or one sent from another window.
    const free = run([{ type: "userScrollIntent" }], anchored);
    expect(run([send("u3", false)], free)).toBe(free);
    // Following at the end, the message is anchored as a send would be.
    expect(run([send("u3", false)]).mode).toBe("anchored");
  });

  it("leaves a following reader scrolled into history alone for a message not sent here", () => {
    // Opened the thread and scrolled up: still following, but away from the end.
    const scrolled = run([{ type: "userScrollIntent" }]);
    expect(scrolled.mode).toBe("follow");
    expect(run([send("u3", false, true)], scrolled)).toBe(scrolled);
    // Their own send anchors wherever they are.
    expect(run([send("u3", true, true)], scrolled).mode).toBe("anchored");
    // Anchored, the reader has not scrolled since their send: the next one anchors.
    expect(run([send("u3", false, true)], anchored).sentRowId).toBe("u3");
  });

  it("releases to the reader on a scroll, keeping the reserve", () => {
    const state = run([{ type: "userScrollIntent" }], anchored);
    expect(state.mode).toBe("free");
    expect(sendAnchorProps(state)).toEqual({
      maintainScrollAtEnd: false,
      anchorRowId: null,
      reserveRowId: "u2",
    });
  });

  it("hands the scroll to the reader when they open a fold, following or anchored", () => {
    // Following, the list would scroll to its new end past the toggle.
    const opened = run([{ type: "rowsOpened" }]);
    expect(opened.mode).toBe("free");
    expect(sendAnchorProps(opened).maintainScrollAtEnd).toBe(false);
    expect(run([{ type: "rowsOpened" }], anchored).mode).toBe("free");
    expect(run([{ type: "rowsOpened" }], opened)).toBe(opened);
    // Back at the end, the list follows again.
    expect(run([{ type: "reachedEnd" }], opened).mode).toBe("follow");
  });

  it("ignores scrolls while following", () => {
    expect(run([{ type: "userScrollIntent" }])).toBe(INITIAL_SEND_ANCHOR);
  });

  it("resumes following when the reader reaches the end", () => {
    const state = run([{ type: "userScrollIntent" }, { type: "reachedEnd" }], anchored);
    expect(state.mode).toBe("follow");
    expect(sendAnchorProps(state).maintainScrollAtEnd).toBe(true);
    expect(sendAnchorProps(state).reserveRowId).toBe("u2");
  });

  it("stays anchored at the end the reserve makes", () => {
    expect(run([{ type: "reachedEnd" }], anchored)).toBe(anchored);
  });

  it("resumes following on a jump, from any mode", () => {
    expect(run([{ type: "jumpToLatest" }], anchored).mode).toBe("follow");
    const free = run([{ type: "userScrollIntent" }], anchored);
    expect(run([{ type: "jumpToLatest" }], free).mode).toBe("follow");
    expect(run([{ type: "jumpToLatest" }])).toBe(INITIAL_SEND_ANCHOR);
  });
});

describe("a list reopened at a saved place", () => {
  const restored = initialSendAnchor(true);

  it("starts free, not following, and otherwise as a fresh list", () => {
    expect(initialSendAnchor(false)).toBe(INITIAL_SEND_ANCHOR);
    expect(restored.mode).toBe("free");
    expect(sendAnchorProps(restored)).toEqual({
      maintainScrollAtEnd: false,
      anchorRowId: null,
      reserveRowId: null,
    });
  });

  it("stays free on its first rows: the history it opens with is not a send", () => {
    expect(run([{ type: "rowsChanged", turnActive: true }], restored)).toBe(restored);
    // A message drained from the queue, or sent from another window, leaves the place alone.
    expect(run([send("u3", false)], restored)).toBe(restored);
  });

  it("follows again at the end, or on a jump", () => {
    expect(run([{ type: "reachedEnd" }], restored).mode).toBe("follow");
    expect(run([{ type: "jumpToLatest" }], restored).mode).toBe("follow");
  });

  it("anchors the reader's own send", () => {
    const state = run([send("u3")], restored);
    expect(state.mode).toBe("anchored");
    expect(sendAnchorProps(state).anchorRowId).toBe("u3");
  });
});

describe("bulk fold changes", () => {
  // Rows 100px tall from 0; the viewport shows 250..550.
  const ids = ["u1", "fold1", "a1", "u2", "fold2", "a2", "u3", "a3"];
  const positionAt = (index: number) => (index < ids.length ? index * 100 : undefined);

  it("keeps every row on screen where it sits, then falls back to the rows above", () => {
    expect(viewAnchors(ids, positionAt, 250, 550)).toEqual([
      // The row straddling the top, above it by 50px, then the rest on screen.
      { rowId: "a1", offset: -50 },
      { rowId: "u2", offset: 50 },
      { rowId: "fold2", offset: 150 },
      { rowId: "a2", offset: 250 },
      // Above the viewport, nearest first, to put at the top.
      { rowId: "fold1", offset: 0 },
      { rowId: "u1", offset: 0 },
    ]);
    expect(viewAnchors([], positionAt, 0, 300)).toEqual([]);
  });

  it("picks the first anchor whose row survived the change", () => {
    const anchors = viewAnchors(ids, positionAt, 250, 550);
    // Expand-all only adds rows: the row at the top stays the anchor.
    expect(pickViewAnchor(anchors, () => true)).toEqual({ rowId: "a1", offset: -50 });
    // Collapse-all folded away the work on screen: the next message holds.
    const kept = new Set(["u1", "fold1", "u2", "u3"]);
    expect(pickViewAnchor(anchors, (rowId) => kept.has(rowId))).toEqual({
      rowId: "u2",
      offset: 50,
    });
    // Nothing on screen survived: the nearest row above, the fold, goes to the top.
    expect(pickViewAnchor(anchors, (rowId) => rowId === "fold1" || rowId === "u1")).toEqual({
      rowId: "fold1",
      offset: 0,
    });
    expect(pickViewAnchor(anchors, () => false)).toBeUndefined();
  });

  it("leaves the scroll to the follow only while following at the end", () => {
    expect(bulkFoldKeepsEnd("follow", true)).toBe(true);
    expect(bulkFoldKeepsEnd("follow", false)).toBe(false);
    // Anchored, the list is at its end by design; the held message keeps its place.
    expect(bulkFoldKeepsEnd("anchored", true)).toBe(false);
    expect(bulkFoldKeepsEnd("free", true)).toBe(false);
  });
});

describe("isScrollKey", () => {
  it("knows the keys that scroll a focused list", () => {
    for (const key of ["PageUp", "PageDown", "Home", "End", " ", "ArrowUp", "ArrowDown"]) {
      expect(isScrollKey(key)).toBe(true);
    }
    for (const key of ["a", "Enter", "Escape", "ArrowLeft", "Tab"]) {
      expect(isScrollKey(key)).toBe(false);
    }
  });
});

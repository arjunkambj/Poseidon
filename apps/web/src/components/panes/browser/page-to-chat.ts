/**
 * Bringing the page into the conversation: the element a person picks in the
 * pane, as text the composer gets, and a screenshot of the tab, as an image
 * it attaches.
 *
 * The picker runs in the page (`PICK_SCRIPT`, through the webview's
 * `executeJavaScript`): it outlines the element under the pointer, swallows
 * the click that picks it, and resolves with a short description — a CSS
 * path, the tag, its text and the start of its HTML — or `null` on Escape
 * or when cancelled (`CANCEL_PICK_SCRIPT`). What comes back is the page's
 * own data, so it is checked and cut here and only ever lands in the draft,
 * where the person sees it before anything is sent.
 */

/** Cuts on the page side; checked again on this side. */
const MAX_TEXT = 200;
const MAX_HTML = 2000;

export interface PickedElement {
  readonly selector: string;
  readonly tag: string;
  readonly text: string;
  readonly html: string;
}

/** The page-side picker; one at a time — a second call cancels the first. */
export const PICK_SCRIPT = `(() => new Promise((resolve) => {
  window.__poseidonPicker?.cancel();
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;display:none;outline:2px solid #2563eb;background:rgba(37,99,235,0.12)";
  document.documentElement.appendChild(box);
  let current = null;
  const pathOf = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 5; node = node.parentElement) {
      if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
      let part = node.localName + [...node.classList].slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === node.localName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
    }
    return parts.join(" > ");
  };
  const swallow = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); };
  const move = (event) => {
    if (!(event.target instanceof Element)) return;
    current = event.target;
    const r = current.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  };
  const listeners = [];
  const on = (type, fn) => { addEventListener(type, fn, true); listeners.push([type, fn]); };
  const done = (value) => {
    for (const [type, fn] of listeners) removeEventListener(type, fn, true);
    box.remove();
    delete window.__poseidonPicker;
    resolve(value);
  };
  on("mousemove", move);
  on("pointerdown", swallow);
  on("mousedown", swallow);
  on("mouseup", swallow);
  on("pointerup", swallow);
  on("click", (event) => {
    swallow(event);
    const el = event.target instanceof Element ? event.target : current;
    if (!el) { done(null); return; }
    done({
      selector: pathOf(el),
      tag: el.localName,
      text: (el.innerText || el.textContent || "").trim().slice(0, ${MAX_TEXT}),
      html: el.outerHTML.slice(0, ${MAX_HTML}),
    });
  });
  on("keydown", (event) => { if (event.key === "Escape") { swallow(event); done(null); } });
  window.__poseidonPicker = { cancel: () => done(null) };
}))()`;

export const CANCEL_PICK_SCRIPT = "window.__poseidonPicker?.cancel()";

/**
 * Calls `onGone` when the tab's webview loads a new document, which takes the
 * picker with it; returns the unsubscribe. Only `did-navigate` counts: an
 * in-page navigation (a hash or history change, which some pages make while
 * they scroll) keeps the document, the picker and its capture listeners, so
 * the pick goes on.
 */
export const onNewDocument = (view: EventTarget, onGone: () => void): (() => void) => {
  view.addEventListener("did-navigate", onGone);
  return () => view.removeEventListener("did-navigate", onGone);
};

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" ? value.slice(0, max) : null;

/** The picker's answer, or `null` for a cancel or anything that is not one. */
export const parsePicked = (value: unknown): PickedElement | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const selector = text(record["selector"], 500);
  const tag = text(record["tag"], 64);
  if (selector === null || selector === "" || tag === null || tag === "") return null;
  return {
    selector,
    tag,
    text: text(record["text"], MAX_TEXT) ?? "",
    html: text(record["html"], MAX_HTML) ?? "",
  };
};

/** The picked element as the lines the composer's draft gets. */
export const pickedElementText = (picked: PickedElement, url: string): string => {
  const lines = [`Element \`${picked.selector}\` on ${url}`];
  const shown = picked.text.replace(/\s+/g, " ").trim();
  if (shown !== "") lines.push(`Text: "${shown}"`);
  if (picked.html !== "") lines.push("```html", picked.html, "```");
  return lines.join("\n");
};

/** The draft with `addition` after what is there, a blank line between. */
export const appendToDraft = (draft: string, addition: string): string =>
  draft.trim() === "" ? addition : `${draft.replace(/\s+$/, "")}\n\n${addition}`;

/** The screenshot as a file the composer attaches, named after the page's host. */
export const screenshotFile = (png: Uint8Array, url: string, now: Date): File => {
  let host = "page";
  try {
    host = new URL(url).hostname || "page";
  } catch {
    // An about: page or no address yet.
  }
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const bytes = new Uint8Array(png);
  return new File([bytes], `screenshot-${host}-${stamp}.png`, { type: "image/png" });
};

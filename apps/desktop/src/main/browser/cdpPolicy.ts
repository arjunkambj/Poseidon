/**
 * What the browser bridge does with one CDP command from a client.
 *
 * The bridge pretends to be a browser whose only pages are one thread's pane
 * webviews. A client talks on two kinds of session:
 *
 * - **root** — the connection itself, where a real browser answers `Browser.*`
 *   and `Target.*`. Here nothing reaches Chromium: `Browser.getVersion` is
 *   answered locally, the handful of `Target.*` calls agent-browser needs are
 *   virtualized over the thread's guests, and every other method is refused.
 *   A guest's own debugger can see the app window among its targets, so no
 *   browser-level command is ever passed through.
 * - **page** — a flat session on one guest. The listed domains are forwarded
 *   to that guest's debugger. `Target.*` stays virtual here too (only
 *   auto-attach, which scopes itself to the page's own frames and workers, is
 *   forwarded), `Page.reload` becomes a guest reload — Chromium's reload of a
 *   guest view reloads the whole app window — and `Page.bringToFront` selects
 *   the pane tab.
 *
 * A page is laid out at its pane's size, and `Emulation` is granted method by
 * method rather than as a domain so that it stays that way. The calls that
 * would lay the page out at a size or scale of their own are refused: a
 * device metrics override is not a view onto the pane, it replaces it, and
 * the guest keeps it for as long as the client stays attached. This is
 * hardening, not a fix for anything seen: none of the agent's browser tools
 * sends an `Emulation` call (the server's catalogue has no `set` command), and
 * only a CLI holding the launch key could. The person sizes the page by
 * resizing the dock.
 *
 * The list fails closed: a method this file does not name is refused, so a
 * new agent-browser or Electron release that needs more shows up as an
 * error in the tool result rather than as silently widened access. Re-check it
 * against a fresh recording on every upgrade of either.
 *
 * Pure: `classify` reads the method and params and nothing else.
 */

export type SessionScope = "root" | "page";

export type PolicyDecision =
  /** The bridge answers from what it knows (`Browser.getVersion`, target info). */
  | { readonly kind: "answer-locally" }
  /** The bridge acts on the guests itself (targets, reload, bring to front). */
  | { readonly kind: "virtualize" }
  /** Sent to the guest's debugger on the client's session. */
  | { readonly kind: "forward" }
  /** Native input: sent while the guest holds window focus, one at a time. */
  | { readonly kind: "forward-with-focus" }
  | { readonly kind: "deny"; readonly reason: string };

const ANSWER: PolicyDecision = { kind: "answer-locally" };
const VIRTUALIZE: PolicyDecision = { kind: "virtualize" };
const FORWARD: PolicyDecision = { kind: "forward" };
const WITH_FOCUS: PolicyDecision = { kind: "forward-with-focus" };
const deny = (reason: string): PolicyDecision => ({ kind: "deny", reason });

/** The one page URL the bridge admits that is not http(s). */
const BLANK = "about:blank";

/** http(s), or exactly `about:blank`. Never file:, chrome:, devtools:, data: or javascript:. */
export const isWebUrl = (value: unknown): boolean => {
  if (value === BLANK) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/** Root-session `Target.*` calls the bridge answers over the thread's guests. */
const ROOT_TARGET = new Set([
  "Target.setDiscoverTargets",
  "Target.getTargets",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Target.createTarget",
  "Target.closeTarget",
]);

/** Domains a page session may use on its own guest. */
const PAGE_DOMAINS = new Set([
  "Runtime",
  "Page",
  "DOM",
  "Accessibility",
  "Input",
  "Network",
  "CSS",
  "DOMSnapshot",
  "Overlay",
  "Log",
  "Performance",
  "Fetch",
  "WebMCP",
]);

/**
 * Methods inside those domains that reach past the page, each with why.
 * Cookie-jar calls read or write the partition's whole jar, httpOnly cookies
 * included, which page script never sees. Certificate overrides live in the
 * `Security` domain, which is not listed at all.
 */
const PAGE_DENIED = new Map<string, string>([
  ["Page.close", "closing a pane tab goes through Target.closeTarget"],
  ["Page.crash", "crashing the guest is not granted"],
  ["Page.setDownloadBehavior", "downloads are not granted"],
  ["DOM.setFileInputFiles", "file uploads are not granted"],
  ["Input.setIgnoreInputEvents", "locking the user out of the pane is not granted"],
  ["Network.getAllCookies", "the cookie jar is not granted"],
  ["Network.getCookies", "the cookie jar is not granted"],
  ["Network.setCookie", "the cookie jar is not granted"],
  ["Network.setCookies", "the cookie jar is not granted"],
  ["Network.deleteCookies", "the cookie jar is not granted"],
  ["Network.clearBrowserCookies", "the cookie jar is not granted"],
  ["Network.clearBrowserCache", "clearing browsing data is the user's"],
  ["Network.setCookieControls", "the cookie jar is not granted"],
  ["Network.continueInterceptedRequest", "request rewriting goes through Fetch"],
]);

/**
 * The `Emulation` calls a page session may make: none of them changes the
 * size or scale the page is laid out at. What agent-browser sends for
 * `set media`, `set geo`, `set timezone`, `set locale` and a user agent, plus
 * the two clears, which only put the page back as the pane shows it.
 */
const EMULATION_GRANTED = new Set([
  "Emulation.setEmulatedMedia",
  "Emulation.setGeolocationOverride",
  "Emulation.clearGeolocationOverride",
  "Emulation.setLocaleOverride",
  "Emulation.setTimezoneOverride",
  "Emulation.setUserAgentOverride",
  "Emulation.clearDeviceMetricsOverride",
]);

/** Calls that would lay the page out at a size or scale other than the pane's. */
const SIZE_OVERRIDES = new Set([
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setVisibleSize",
  "Emulation.setPageScaleFactor",
  // Removed from the protocol, refused by name in case a Chromium still has it.
  "Page.setDeviceMetricsOverride",
]);

/** Page methods that carry a URL, and the param it is in. */
const URL_PARAM = new Map<string, { readonly name: string; readonly optional: boolean }>([
  ["Page.navigate", { name: "url", optional: false }],
  ["Network.loadNetworkResource", { name: "url", optional: false }],
  ["Fetch.continueRequest", { name: "url", optional: true }],
]);

/** Native input goes to the window's focused widget, so the guest must hold focus. */
const FOCUSED_INPUT = new Set([
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Input.imeSetComposition",
  "Input.dispatchMouseEvent",
]);

type Params = Readonly<Record<string, unknown>> | undefined;

/** Whether a drag event's `data` names any local files. */
const carriesFiles = (params: Params): boolean => {
  const data = params?.["data"];
  if (typeof data !== "object" || data === null) return false;
  const files = (data as Record<string, unknown>)["files"];
  return files !== undefined && !(Array.isArray(files) && files.length === 0);
};

const classifyRoot = (method: string, params: Params): PolicyDecision => {
  if (method === "Browser.getVersion") {
    return ANSWER;
  }
  if (!ROOT_TARGET.has(method)) {
    return deny(`${method} is not available on this endpoint`);
  }
  if (method === "Target.attachToTarget" && params?.["flatten"] !== true) {
    return deny("Only flat sessions are supported");
  }
  if (method === "Target.createTarget") {
    const url = params?.["url"];
    if (url !== undefined && url !== "" && !isWebUrl(url)) {
      return deny("Only http(s) and about:blank pages may be opened");
    }
  }
  return VIRTUALIZE;
};

const classifyPage = (method: string, params: Params): PolicyDecision => {
  const domain = method.slice(0, method.indexOf("."));
  if (method === "Target.getTargetInfo") {
    return ANSWER;
  }
  if (method === "Target.setAutoAttach") {
    return FORWARD;
  }
  if (domain === "Target" || domain === "Browser") {
    return deny(`${method} is browser-wide and denied`);
  }
  if (SIZE_OVERRIDES.has(method)) {
    return deny(
      `${method}: the page is laid out at the browser pane's size, which the person sets by resizing the dock`,
    );
  }
  if (domain === "Emulation") {
    return EMULATION_GRANTED.has(method) ? FORWARD : deny(`${method} is not granted`);
  }
  if (!PAGE_DOMAINS.has(domain)) {
    return deny(`${method} is outside this target`);
  }
  const denied = PAGE_DENIED.get(method);
  if (denied !== undefined) {
    return deny(`${method}: ${denied}`);
  }
  // A drag's `data.files` are local paths the guest is granted and handed as
  // `File`s on drop: an upload by another name.
  if (method === "Input.dispatchDragEvent" && carriesFiles(params)) {
    return deny(`${method}: file uploads are not granted`);
  }
  const urlParam = URL_PARAM.get(method);
  if (urlParam !== undefined) {
    const url = params?.[urlParam.name];
    if (!(urlParam.optional && url === undefined) && !isWebUrl(url)) {
      return deny("Only http(s) and about:blank pages may be opened");
    }
  }
  if (method === "Page.reload" || method === "Page.bringToFront") {
    return VIRTUALIZE;
  }
  return FOCUSED_INPUT.has(method) ? WITH_FOCUS : FORWARD;
};

/** The bridge's decision for `method` on a session of `scope`. */
export const classify = (scope: SessionScope, method: string, params?: Params): PolicyDecision =>
  scope === "root" ? classifyRoot(method, params) : classifyPage(method, params);

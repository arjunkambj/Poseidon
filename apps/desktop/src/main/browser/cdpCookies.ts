/**
 * Keeps the partition's cookies out of what a bridge client sees and sends.
 *
 * `cdpPolicy.ts` refuses the cookie-jar calls because they read or write
 * cookies page script never sees, httpOnly ones included. The `Network` and
 * `Fetch` domains it does grant carry the same data another way: once
 * `Network.enable` is on, the browser-side network handler reports the raw
 * `Cookie` request header and full cookie objects (`associatedCookies`) in
 * `Network.requestWillBeSentExtraInfo`, raw `Set-Cookie` in
 * `Network.responseReceivedExtraInfo`, and the same headers on WebSocket
 * handshakes and paused `Fetch` responses. A client could navigate the
 * thread's partition to any site and read every cookie sent to it.
 *
 * So the bridge scrubs every `Network.*` / `Fetch.*` message it relays to a
 * client — events and command results alike — and refuses a `Fetch` response
 * rewrite that would set a cookie. Scrubbing removes:
 *
 * - `Cookie`, `Set-Cookie` and `Set-Cookie2` from any header map or
 *   `{ name, value }` header list under `headers`, `requestHeaders` or
 *   `responseHeaders`;
 * - the cookie lists (`associatedCookies`, `blockedCookies`,
 *   `exemptedCookies`) and the raw header text (`headersText`,
 *   `requestHeadersText`), which repeats those headers verbatim.
 *
 * Pure: nothing here touches Electron.
 */

const COOKIE_HEADERS = new Set(["cookie", "set-cookie", "set-cookie2"]);
const HEADER_FIELDS = new Set(["headers", "requestHeaders", "responseHeaders"]);
const DROPPED_FIELDS = new Set([
  "associatedCookies",
  "blockedCookies",
  "exemptedCookies",
  "headersText",
  "requestHeadersText",
]);

/** Whether `method` is in a domain whose messages can carry cookies. */
const carriesCookies = (method: string): boolean =>
  method.startsWith("Network.") || method.startsWith("Fetch.");

const isCookieHeader = (name: unknown): boolean =>
  typeof name === "string" && COOKIE_HEADERS.has(name.toLowerCase());

/** Whether one `{ name, value }` header list entry is a cookie header. */
const isCookieEntry = (entry: unknown): boolean =>
  typeof entry === "object" && entry !== null && isCookieHeader(Reflect.get(entry, "name"));

const scrubHeaders = (headers: unknown): unknown => {
  if (Array.isArray(headers)) {
    return headers.filter((entry) => !isCookieEntry(entry));
  }
  if (typeof headers === "object" && headers !== null) {
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !isCookieHeader(name)));
  }
  return headers;
};

const scrub = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(scrub);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (DROPPED_FIELDS.has(key)) continue;
    out[key] = HEADER_FIELDS.has(key) ? scrubHeaders(field) : scrub(field);
  }
  return out;
};

/** `value` (an event's params or a command's result) without its cookies. */
export const withoutCookies = (method: string, value: unknown): unknown =>
  carriesCookies(method) ? scrub(value) : value;

/** Decodes `Fetch`'s base64, NUL-separated `name: value` header block. */
const binaryHeaderNames = (encoded: unknown): ReadonlyArray<string> | null => {
  if (typeof encoded !== "string") return [];
  try {
    return atob(encoded)
      .split("\0")
      .map((line) => line.slice(0, line.indexOf(":")).trim());
  } catch {
    return null;
  }
};

/** Whether a `Fetch` response rewrite would hand the page's jar a cookie. */
export const setsCookie = (method: string, params: unknown): boolean => {
  if (method !== "Fetch.fulfillRequest" && method !== "Fetch.continueResponse") {
    return false;
  }
  if (typeof params !== "object" || params === null) return false;
  const record = params as Record<string, unknown>;
  const listed = record["responseHeaders"];
  if (Array.isArray(listed) && listed.some(isCookieEntry)) {
    return true;
  }
  const binary = binaryHeaderNames(record["binaryResponseHeaders"]);
  return binary === null || binary.some(isCookieHeader);
};

import { describe, expect, it } from "vitest";

import { setsCookie, withoutCookies } from "./cdpCookies";

const base64 = (text: string): string => btoa(text);

describe("withoutCookies", () => {
  it("strips the raw cookie headers and cookie lists from the ExtraInfo events", () => {
    expect(
      withoutCookies("Network.requestWillBeSentExtraInfo", {
        requestId: "1",
        headers: { Cookie: "sid=secret", accept: "*/*" },
        associatedCookies: [{ cookie: { name: "sid", value: "secret", httpOnly: true } }],
        exemptedCookies: [],
      }),
    ).toEqual({ requestId: "1", headers: { accept: "*/*" } });
    expect(
      withoutCookies("Network.responseReceivedExtraInfo", {
        requestId: "1",
        headers: { "set-cookie": "sid=secret; HttpOnly", "content-type": "text/html" },
        blockedCookies: [{ cookieLine: "sid=secret" }],
        headersText: "HTTP/1.1 200 OK\r\nSet-Cookie: sid=secret\r\n",
        statusCode: 200,
      }),
    ).toEqual({ requestId: "1", headers: { "content-type": "text/html" }, statusCode: 200 });
  });

  it("strips nested request and response headers, WebSocket handshakes included", () => {
    expect(
      withoutCookies("Network.webSocketHandshakeResponseReceived", {
        response: {
          status: 101,
          headers: { "Set-Cookie": "a=b" },
          requestHeaders: { Cookie: "a=b", Host: "x" },
          requestHeadersText: "Cookie: a=b",
        },
      }),
    ).toEqual({ response: { status: 101, headers: {}, requestHeaders: { Host: "x" } } });
  });

  it("strips Set-Cookie from a paused Fetch response and a loaded resource", () => {
    expect(
      withoutCookies("Fetch.requestPaused", {
        requestId: "r",
        responseHeaders: [
          { name: "Set-Cookie", value: "sid=secret" },
          { name: "Content-Type", value: "text/html" },
        ],
      }),
    ).toEqual({ requestId: "r", responseHeaders: [{ name: "Content-Type", value: "text/html" }] });
    expect(
      withoutCookies("Network.loadNetworkResource", {
        resource: { success: true, headers: { "set-cookie": "a=b", etag: "1" } },
      }),
    ).toEqual({ resource: { success: true, headers: { etag: "1" } } });
  });

  it("leaves other domains alone", () => {
    const params = { headers: { Cookie: "not a network message" } };
    expect(withoutCookies("Runtime.consoleAPICalled", params)).toBe(params);
  });
});

describe("setsCookie", () => {
  it("catches a Set-Cookie in a Fetch response rewrite, listed or binary", () => {
    for (const method of ["Fetch.fulfillRequest", "Fetch.continueResponse"]) {
      expect(
        setsCookie(method, {
          requestId: "r",
          responseHeaders: [{ name: "set-cookie", value: "a" }],
        }),
      ).toBe(true);
      expect(
        setsCookie(method, {
          requestId: "r",
          binaryResponseHeaders: base64("Content-Type: text/html\0Set-Cookie: a=b"),
        }),
      ).toBe(true);
      expect(setsCookie(method, { requestId: "r", binaryResponseHeaders: "%%not base64" })).toBe(
        true,
      );
      expect(
        setsCookie(method, {
          requestId: "r",
          responseHeaders: [{ name: "Content-Type", value: "text/html" }],
          binaryResponseHeaders: base64("Content-Type: text/html"),
        }),
      ).toBe(false);
    }
  });

  it("only looks at response rewrites", () => {
    expect(
      setsCookie("Fetch.continueRequest", { headers: [{ name: "Set-Cookie", value: "a" }] }),
    ).toBe(false);
  });
});

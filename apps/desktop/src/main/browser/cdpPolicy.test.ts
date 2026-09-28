import { describe, expect, it } from "vitest";

import { readFrames, recordingNames } from "@poseidon/testkit/recording";

import { classify, isWebUrl, type SessionScope } from "./cdpPolicy";

const kind = (scope: SessionScope, method: string, params?: Record<string, unknown>) =>
  classify(scope, method, params).kind;

describe("classify, against what agent-browser 0.38.1 actually sends", () => {
  const sent = recordingNames("agent-browser").flatMap((scenario) =>
    readFrames("agent-browser", scenario)
      .filter((frame) => frame.dir === "from-harness")
      .map((frame) => {
        const data = frame.data as {
          method: string;
          sessionId?: string;
          params?: Record<string, unknown>;
        };
        const params = JSON.parse(
          JSON.stringify(data.params ?? {}).replaceAll("<SITE_PORT>", "4173"),
        ) as Record<string, unknown>;
        return {
          scenario,
          scope: data.sessionId ? "page" : ("root" as SessionScope),
          data,
          params,
        };
      }),
  );

  it("has recordings to check", () => {
    expect(sent.length).toBeGreaterThan(100);
  });

  it("allows every command in every recording", () => {
    const denied = sent.filter(
      ({ scope, data, params }) => kind(scope, data.method, params) === "deny",
    );
    expect(denied.map(({ scenario, data }) => `${scenario}: ${data.method}`)).toEqual([]);
  });

  it("sends the recorded native input through the focus queue", () => {
    const input = sent.filter(({ data }) => data.method.startsWith("Input."));
    expect(input.length).toBeGreaterThan(0);
    for (const { scope, data, params } of input) {
      expect(kind(scope, data.method, params)).toBe("forward-with-focus");
    }
  });
});

describe("classify on the root session", () => {
  it("answers Browser.getVersion and virtualizes the target calls", () => {
    expect(kind("root", "Browser.getVersion")).toBe("answer-locally");
    for (const method of [
      "Target.setDiscoverTargets",
      "Target.getTargets",
      "Target.detachFromTarget",
      "Target.closeTarget",
    ]) {
      expect(kind("root", method, {})).toBe("virtualize");
    }
    expect(kind("root", "Target.attachToTarget", { targetId: "x", flatten: true })).toBe(
      "virtualize",
    );
    expect(kind("root", "Target.createTarget", { url: "about:blank" })).toBe("virtualize");
    expect(kind("root", "Target.createTarget", { url: "https://example.com/" })).toBe("virtualize");
    expect(kind("root", "Target.createTarget", {})).toBe("virtualize");
  });

  // Every browser-level call the attach spike tried and saw refused.
  it.each([
    "Browser.close",
    "Browser.crash",
    "Browser.setDownloadBehavior",
    "Browser.grantPermissions",
    "SystemInfo.getInfo",
    "SystemInfo.getProcessInfo",
    "Tethering.bind",
    "Target.createBrowserContext",
    "Target.exposeDevToolsProtocol",
    "Target.setRemoteLocations",
    "Target.attachToBrowserTarget",
    "Target.setAutoAttach",
    "Target.activateTarget",
    "Storage.getCookies",
    "Tracing.start",
    "Memory.getBrowserSamplingProfile",
    "Runtime.evaluate",
    "Page.navigate",
  ])("refuses %s", (method) => {
    expect(kind("root", method, {})).toBe("deny");
  });

  it("refuses a non-flat attach and a non-web tab", () => {
    expect(classify("root", "Target.attachToTarget", { targetId: "x" })).toEqual({
      kind: "deny",
      reason: "Only flat sessions are supported",
    });
    expect(kind("root", "Target.attachToTarget", { targetId: "x", flatten: false })).toBe("deny");
    for (const url of ["file:///etc/passwd", "chrome://settings", "devtools://devtools/x"]) {
      expect(kind("root", "Target.createTarget", { url })).toBe("deny");
    }
  });
});

describe("classify on a page session", () => {
  it("forwards the page domains and keeps target info local", () => {
    expect(kind("page", "Runtime.evaluate", { expression: "1" })).toBe("forward");
    expect(kind("page", "Accessibility.getFullAXTree")).toBe("forward");
    expect(kind("page", "Page.captureScreenshot")).toBe("forward");
    expect(kind("page", "Target.setAutoAttach", { autoAttach: true, flatten: true })).toBe(
      "forward",
    );
    expect(kind("page", "Target.getTargetInfo")).toBe("answer-locally");
  });

  it("does reload and bring-to-front itself", () => {
    expect(kind("page", "Page.reload")).toBe("virtualize");
    expect(kind("page", "Page.bringToFront")).toBe("virtualize");
  });

  it("runs native input with focus", () => {
    for (const method of [
      "Input.dispatchKeyEvent",
      "Input.insertText",
      "Input.imeSetComposition",
      "Input.dispatchMouseEvent",
    ]) {
      expect(kind("page", method, {})).toBe("forward-with-focus");
    }
    expect(kind("page", "Input.dispatchTouchEvent", {})).toBe("forward");
  });

  // Every page-level call the attach spike tried and saw refused, and the rest of the list.
  it.each([
    "Page.close",
    "Page.crash",
    "Page.setDownloadBehavior",
    "DOM.setFileInputFiles",
    "IO.read",
    "IO.close",
    "Input.setIgnoreInputEvents",
    "Network.getAllCookies",
    "Network.getCookies",
    "Network.setCookie",
    "Network.setCookies",
    "Network.deleteCookies",
    "Network.clearBrowserCookies",
    "Network.clearBrowserCache",
    "Security.setIgnoreCertificateErrors",
    "Security.handleCertificateError",
    "Storage.clearDataForOrigin",
    "Browser.getVersion",
    "Browser.close",
    "Target.getTargets",
    "Target.attachToTarget",
    "Target.createTarget",
    "Target.exposeDevToolsProtocol",
    "Debugger.enable",
    "SystemInfo.getInfo",
  ])("refuses %s", (method) => {
    expect(kind("page", method, {})).toBe("deny");
  });

  it("forwards a drag without files and refuses one that carries local files", () => {
    const drag = { type: "dragEnter", x: 1, y: 1, modifiers: 0 };
    expect(kind("page", "Input.dispatchDragEvent", drag)).toBe("forward");
    expect(
      kind("page", "Input.dispatchDragEvent", {
        ...drag,
        data: { items: [], dragOperationsMask: 1 },
      }),
    ).toBe("forward");
    expect(
      kind("page", "Input.dispatchDragEvent", {
        ...drag,
        data: { items: [], files: [], dragOperationsMask: 1 },
      }),
    ).toBe("forward");
    for (const files of [["/etc/passwd"], "/etc/passwd", null]) {
      expect(
        kind("page", "Input.dispatchDragEvent", {
          ...drag,
          type: "drop",
          data: { items: [], files, dragOperationsMask: 1 },
        }),
      ).toBe("deny");
    }
  });

  it("never lets an emulated viewport replace the pane's size", () => {
    // What `agent-browser set viewport 1280 720` sends first.
    expect(
      classify("page", "Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    ).toEqual({
      kind: "deny",
      reason:
        "Emulation.setDeviceMetricsOverride: the page is laid out at the browser pane's size, which the person sets by resizing the dock",
    });
    for (const method of [
      "Emulation.setVisibleSize",
      "Emulation.setPageScaleFactor",
      "Page.setDeviceMetricsOverride",
    ]) {
      expect(classify("page", method, {})).toMatchObject({
        kind: "deny",
        reason: expect.stringContaining("the browser pane's size"),
      });
    }
  });

  it("grants Emulation only method by method", () => {
    for (const method of [
      "Emulation.setEmulatedMedia",
      "Emulation.setGeolocationOverride",
      "Emulation.clearGeolocationOverride",
      "Emulation.setLocaleOverride",
      "Emulation.setTimezoneOverride",
      "Emulation.setUserAgentOverride",
      "Emulation.clearDeviceMetricsOverride",
    ]) {
      expect(kind("page", method, {})).toBe("forward");
    }
    for (const method of [
      "Emulation.setSafeAreaInsetsOverride",
      "Emulation.setDisplayFeaturesOverride",
      "Emulation.setVirtualTimePolicy",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setScriptExecutionDisabled",
      "Emulation.setSomethingNew",
    ]) {
      expect(classify("page", method, {})).toEqual({
        kind: "deny",
        reason: `${method} is not granted`,
      });
    }
  });

  it("refuses navigation anywhere but the web", () => {
    for (const url of [
      "file:///etc/passwd",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "chrome-extension://abc/x.html",
      "javascript:alert(1)",
      "data:text/html,<p>x</p>",
      "about:config",
      "view-source:https://example.com",
      undefined,
      42,
    ]) {
      expect(kind("page", "Page.navigate", { url })).toBe("deny");
      expect(kind("page", "Network.loadNetworkResource", { url })).toBe("deny");
    }
    expect(kind("page", "Page.navigate", { url: "https://example.com/" })).toBe("forward");
    expect(kind("page", "Page.navigate", { url: "about:blank" })).toBe("forward");
    expect(kind("page", "Fetch.continueRequest", { requestId: "1" })).toBe("forward");
    expect(kind("page", "Fetch.continueRequest", { requestId: "1", url: "file:///x" })).toBe(
      "deny",
    );
  });

  it("refuses a Fetch response rewrite that would set a cookie", () => {
    for (const method of ["Fetch.fulfillRequest", "Fetch.continueResponse"]) {
      expect(
        classify("page", method, {
          requestId: "r",
          responseHeaders: [{ name: "Set-Cookie", value: "sid=planted" }],
        }),
      ).toEqual({ kind: "deny", reason: `${method}: the cookie jar is not granted` });
      expect(
        kind("page", method, {
          requestId: "r",
          responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
        }),
      ).toBe("forward");
    }
  });
});

describe("isWebUrl", () => {
  it("admits http(s) and exactly about:blank", () => {
    expect(isWebUrl("http://localhost:3000/")).toBe(true);
    expect(isWebUrl("https://example.com")).toBe(true);
    expect(isWebUrl("about:blank")).toBe(true);
    expect(isWebUrl("about:blank#x")).toBe(false);
    expect(isWebUrl("ws://127.0.0.1:1/")).toBe(false);
    expect(isWebUrl("not a url")).toBe(false);
  });
});

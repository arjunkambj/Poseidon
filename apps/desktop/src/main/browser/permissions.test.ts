import { describe, expect, it } from "vitest";

import { panePermissionAllowed, securePaneSession, type PermissionSession } from "./permissions";

type RequestHandler = (
  contents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
) => void;
type CheckHandler = (contents: unknown, permission: string) => boolean;

/** A session that records the handlers installed on it. */
const fakeSession = () => {
  const installed = {
    request: null as RequestHandler | null,
    check: null as CheckHandler | null,
    device: null as (() => boolean) | null,
    calls: 0,
  };
  const session = {
    setPermissionRequestHandler: (handler: RequestHandler) => {
      installed.calls += 1;
      installed.request = handler;
    },
    setPermissionCheckHandler: (handler: CheckHandler) => {
      installed.check = handler;
    },
    setDevicePermissionHandler: (handler: () => boolean) => {
      installed.device = handler;
    },
  } as unknown as PermissionSession;
  return { session, installed };
};

const request = (handler: RequestHandler | null, permission: string): boolean => {
  let granted: boolean | null = null;
  handler?.({}, permission, (value) => {
    granted = value;
  });
  if (granted === null) throw new Error(`no answer for ${permission}`);
  return granted;
};

const DENIED = [
  "openExternal",
  "clipboard-read",
  "deprecated-sync-clipboard-read",
  "media",
  "geolocation",
  "notifications",
  "midiSysex",
  "local-network-access",
  "loopback-network",
  "fileSystem",
  "window-management",
  "display-capture",
  "unknown",
];

describe("pane permissions", () => {
  it("grants only fullscreen and plain clipboard writes", () => {
    expect(panePermissionAllowed("fullscreen")).toBe(true);
    expect(panePermissionAllowed("clipboard-sanitized-write")).toBe(true);
    for (const permission of DENIED) expect(panePermissionAllowed(permission)).toBe(false);
  });

  it("denies openExternal, clipboard reads, media and geolocation on request and on check", () => {
    const { session, installed } = fakeSession();
    securePaneSession(session);
    for (const permission of DENIED) {
      expect(request(installed.request, permission)).toBe(false);
      expect(installed.check?.({}, permission)).toBe(false);
    }
    expect(request(installed.request, "fullscreen")).toBe(true);
    expect(installed.check?.({}, "clipboard-sanitized-write")).toBe(true);
    expect(installed.device?.()).toBe(false);
  });

  it("installs the handlers once per session", () => {
    const { session, installed } = fakeSession();
    securePaneSession(session);
    securePaneSession(session);
    expect(installed.calls).toBe(1);
  });
});

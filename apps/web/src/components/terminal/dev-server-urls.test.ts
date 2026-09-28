import type { TerminalAttachItem } from "@poseidon/client-runtime/terminalAtoms";
import type { TerminalId } from "@poseidon/contracts/ids";
import type { TerminalSummary } from "@poseidon/contracts/terminal";
import { describe, expect, it, vi } from "vitest";

import {
  devServerLabel,
  devServerUrls,
  makeUrlScanner,
  scanningDevServers,
  stripAnsi,
} from "./dev-server-urls";

const esc = "\u001b";
const bold = (text: string) => `${esc}[1m${text}${esc}[22m`;
const cyan = (text: string) => `${esc}[36m${text}${esc}[39m`;

// Vite's banner, colours and all: the port is bold inside the cyan URL.
const vite = [
  "",
  `  ${esc}[32m${esc}[1mVITE${esc}[22m v6.0.0${esc}[39m  ${esc}[2mready in ${esc}[0m${bold("312")} ms`,
  "",
  `  ${esc}[32m➜${esc}[39m  ${bold("Local")}:   ${cyan(`http://localhost:${bold("5173")}/`)}`,
  `  ${esc}[32m➜${esc}[39m  ${bold("Network")}: ${cyan(`http://192.168.1.20:${bold("5173")}/`)}`,
  "",
].join("\r\n");

const next = [
  `   ${esc}[1m${esc}[38;2;173;127;168m▲ Next.js 15.1.0${esc}[39m${esc}[22m`,
  "   - Local:        http://localhost:3000",
  "   - Network:      http://10.0.0.4:3000",
  "",
  ` ${esc}[32m${esc}[1m✓${esc}[22m${esc}[39m Starting...`,
  "",
].join("\r\n");

describe("stripAnsi", () => {
  it("drops colour codes, cursor moves and titles", () => {
    expect(stripAnsi(`${esc}[2K${esc}[1G${cyan("ok")} ${esc}]0;title\u0007done`)).toBe("ok done");
  });
});

describe("devServerUrls", () => {
  it("reads Vite's local URL and leaves the network one out", () => {
    expect(devServerUrls(vite)).toEqual(["http://localhost:5173/"]);
  });

  it("reads Next's local URL", () => {
    expect(devServerUrls(next)).toEqual(["http://localhost:3000/"]);
  });

  it("opens 0.0.0.0 as localhost", () => {
    expect(devServerUrls(`${cyan("Listening on http://0.0.0.0:3000")}\r\n`)).toEqual([
      "http://localhost:3000/",
    ]);
  });

  it("takes every loopback host, with a path", () => {
    expect(
      devServerUrls(
        "http://127.0.0.1:8080/app https://[::1]:8443 http://web.localhost:1355/docs?x=1",
      ),
    ).toEqual([
      "http://127.0.0.1:8080/app",
      "https://[::1]:8443/",
      "http://web.localhost:1355/docs?x=1",
    ]);
  });

  it("ignores other hosts, a look-alike and other schemes", () => {
    expect(
      devServerUrls(
        "http://example.com:3000 http://localhost.example.com/ http://10.0.0.1 ftp://localhost:21 ws://localhost:24678",
      ),
    ).toEqual([]);
  });

  it("trims the sentence around it and colour residue", () => {
    expect(
      devServerUrls("Server at (http://localhost:4000). Or http://localhost:4001/, then [39m"),
    ).toEqual(["http://localhost:4000/", "http://localhost:4001/"]);
    expect(devServerUrls('url "http://localhost:4002/a"; next')).toEqual([
      "http://localhost:4002/a",
    ]);
    expect(devServerUrls("http://localhost:4003/[39m")).toEqual(["http://localhost:4003/"]);
  });

  it("dedupes, keeps the first printed first and stops at four", () => {
    const text = [5001, 5002, 5001, 5003, 5004, 5005]
      .map((port) => `http://localhost:${port}`)
      .join("\n");
    expect(devServerUrls(text)).toEqual([
      "http://localhost:5001/",
      "http://localhost:5002/",
      "http://localhost:5003/",
      "http://localhost:5004/",
    ]);
  });

  it("refuses a port out of range", () => {
    expect(devServerUrls("http://localhost:99999/")).toEqual([]);
  });
});

describe("devServerLabel", () => {
  it("is host:port", () => {
    expect(devServerLabel("http://localhost:5173/")).toBe("localhost:5173");
    expect(devServerLabel("https://[::1]:8443/")).toBe("[::1]:8443");
  });
});

describe("makeUrlScanner", () => {
  it("finds a URL split across two pieces, once it is followed", () => {
    const scanner = makeUrlScanner();
    expect(scanner.push("  Local:   http://local")).toEqual([]);
    expect(scanner.push("host:51")).toEqual([]);
    expect(scanner.push(`73/${esc}[39m`)).toEqual([]);
    expect(scanner.push("\r\n")).toEqual(["http://localhost:5173/"]);
  });

  it("finds a colour code cut in two", () => {
    const scanner = makeUrlScanner();
    expect(scanner.push(`${esc}[36mhttp://localhost:${esc}[`)).toEqual([]);
    expect(scanner.push(`1m8080${esc}[22m/${esc}[39m\n`)).toEqual(["http://localhost:8080/"]);
  });

  it("reports each URL once", () => {
    const scanner = makeUrlScanner();
    expect(scanner.push("http://localhost:3000 ready\n")).toEqual(["http://localhost:3000/"]);
    expect(scanner.push("restarted at http://localhost:3000 again\n")).toEqual([]);
    expect(scanner.push("also http://127.0.0.1:3001\n")).toEqual(["http://127.0.0.1:3001/"]);
  });

  it("keeps finding URLs after a very long line with no end", () => {
    const scanner = makeUrlScanner();
    expect(scanner.push("x".repeat(10_000))).toEqual([]);
    expect(scanner.push(" http://localhost:1234/\n")).toEqual(["http://localhost:1234/"]);
  });
});

describe("scanningDevServers", () => {
  const terminalId = "0199c0de-0012-7000-8000-000000000001" as TerminalId;
  const summary = (script: boolean): TerminalSummary =>
    ({
      threadId: "0199c0de-0002-7000-8000-000000000001",
      terminalId,
      title: "dev",
      cwd: "/work",
      status: "running",
      pid: 1,
      exitCode: null,
      cols: 80,
      rows: 24,
      ...(script ? { script: { id: "dev", name: "dev" } } : {}),
    }) as unknown as TerminalSummary;
  const snapshot = (script: boolean, data: string): TerminalAttachItem =>
    ({
      kind: "snapshot",
      terminal: summary(script),
      data,
      offset: data.length,
    }) as TerminalAttachItem;
  const output = (data: string, offset: number): TerminalAttachItem =>
    ({ kind: "output", data, offset }) as TerminalAttachItem;

  it("reads a script's scrollback and output, and passes every item on", () => {
    const push = vi.fn();
    const note = vi.fn();
    const scan = scanningDevServers(push, note);
    scan(snapshot(true, "$ vite\r\n  Local: http://localhost:5173/\r\n"));
    scan(output("  Also: http://127.0.0.1:5174/\r\n", 80));
    expect(note.mock.calls).toEqual([[["http://localhost:5173/"]], [["http://127.0.0.1:5174/"]]]);
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("leaves a plain shell's output alone", () => {
    const push = vi.fn();
    const note = vi.fn();
    const scan = scanningDevServers(push, note);
    scan(snapshot(false, "http://localhost:5173/\r\n"));
    scan(output("http://localhost:5174/\r\n", 40));
    expect(note).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("rescans a fresh snapshot", () => {
    const note = vi.fn();
    const scan = scanningDevServers(() => {}, note);
    scan(snapshot(true, "http://localhost:5173/\r\n"));
    scan(snapshot(true, "http://localhost:5173/\r\n"));
    expect(note).toHaveBeenCalledTimes(2);
  });
});

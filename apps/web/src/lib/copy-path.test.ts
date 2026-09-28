import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { copyPath, copyText } from "./copy-path";

describe("copyPath", () => {
  beforeEach(() => {
    toast.success.mockClear();
    toast.error.mockClear();
  });

  it("copies the path and confirms it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    await copyPath("src/app.ts", { writeText });
    expect(writeText).toHaveBeenCalledWith("src/app.ts");
    expect(toast.success).toHaveBeenCalledWith("Copied the path");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says so when the clipboard refuses", async () => {
    await copyPath("src/app.ts", { writeText: () => Promise.reject(new Error("denied")) });
    expect(toast.error).toHaveBeenCalledWith("Could not copy the path");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("says so when there is no clipboard", async () => {
    await copyPath("src/app.ts", undefined);
    expect(toast.error).toHaveBeenCalledWith("Could not copy the path");
  });
});

describe("copyText", () => {
  beforeEach(() => {
    toast.success.mockClear();
    toast.error.mockClear();
  });

  it("copies the text and names what it copied", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    await copyText("fix/login", "branch", { writeText });
    expect(writeText).toHaveBeenCalledWith("fix/login");
    expect(toast.success).toHaveBeenCalledWith("Copied the branch");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("names what it could not copy when the clipboard refuses", async () => {
    await copyText("thread-1", "thread ID", {
      writeText: () => Promise.reject(new Error("denied")),
    });
    expect(toast.error).toHaveBeenCalledWith("Could not copy the thread ID");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("names what it could not copy when there is no clipboard", async () => {
    await copyText("thread-1", "thread ID", undefined);
    expect(toast.error).toHaveBeenCalledWith("Could not copy the thread ID");
  });
});

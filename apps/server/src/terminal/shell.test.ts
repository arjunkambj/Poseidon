import { describe, expect, it } from "vitest";

import { resolveShell, scriptShellCommand, terminalEnv } from "./shell";

const everyFile = () => true;
const noFile = () => false;

describe("resolveShell", () => {
  it("runs $SHELL as a login shell when it is an absolute path", () => {
    expect(resolveShell("darwin", { SHELL: "/opt/homebrew/bin/fish" }, noFile)).toEqual({
      file: "/opt/homebrew/bin/fish",
      args: ["-l"],
    });
    expect(resolveShell("linux", { SHELL: "/usr/bin/bash" }, noFile)).toEqual({
      file: "/usr/bin/bash",
      args: ["-l"],
    });
  });

  it("gives -l only to shells known to take it", () => {
    for (const name of ["zsh", "bash", "fish", "sh", "dash", "ksh"]) {
      expect(resolveShell("linux", { SHELL: `/bin/${name}` }).args).toEqual(["-l"]);
    }
    expect(resolveShell("linux", { SHELL: "/usr/bin/nu" }).args).toEqual([]);
    expect(resolveShell("linux", { SHELL: "/usr/bin/xonsh" }).args).toEqual([]);
  });

  it("ignores an empty or relative $SHELL", () => {
    expect(resolveShell("darwin", { SHELL: "" }).file).toBe("/bin/zsh");
    expect(resolveShell("darwin", { SHELL: "zsh" }).file).toBe("/bin/zsh");
    expect(resolveShell("linux", { SHELL: "bash" }, everyFile).file).toBe("/bin/bash");
  });

  it("falls back to zsh on macOS, bash elsewhere, and sh when there is no bash", () => {
    expect(resolveShell("darwin", {}, noFile)).toEqual({ file: "/bin/zsh", args: ["-l"] });
    expect(resolveShell("linux", {}, (path) => path === "/bin/bash")).toEqual({
      file: "/bin/bash",
      args: ["-l"],
    });
    expect(resolveShell("freebsd", {}, noFile)).toEqual({ file: "/bin/sh", args: ["-l"] });
  });

  it("runs COMSPEC on Windows, else PowerShell, with no arguments", () => {
    expect(resolveShell("win32", { COMSPEC: "C:\\Windows\\system32\\cmd.exe" })).toEqual({
      file: "C:\\Windows\\system32\\cmd.exe",
      args: [],
    });
    expect(resolveShell("win32", { SHELL: "/bin/bash" })).toEqual({
      file: "powershell.exe",
      args: [],
    });
  });
});

describe("scriptShellCommand", () => {
  const command = "pnpm run dev";

  it("starts zsh and bash as interactive login shells, so their rc file sets PATH", () => {
    expect(scriptShellCommand({ file: "/bin/zsh", args: ["-l"] }, command, "darwin")).toEqual({
      file: "/bin/zsh",
      args: ["-i", "-l", "-c", command],
    });
    expect(scriptShellCommand({ file: "/usr/bin/bash", args: ["-l"] }, command, "linux")).toEqual({
      file: "/usr/bin/bash",
      args: ["-i", "-l", "-c", command],
    });
  });

  it("hands another POSIX shell the command with -c, keeping -l on a login shell", () => {
    expect(scriptShellCommand({ file: "/usr/bin/fish", args: ["-l"] }, command, "linux")).toEqual({
      file: "/usr/bin/fish",
      args: ["-l", "-c", command],
    });
    expect(scriptShellCommand({ file: "/bin/sh", args: [] }, command, "linux")).toEqual({
      file: "/bin/sh",
      args: ["-c", command],
    });
  });

  it("runs cmd.exe with /d /s /c and PowerShell with -Command", () => {
    const cmd = "C:\\Windows\\system32\\cmd.exe";
    expect(scriptShellCommand({ file: cmd, args: [] }, command, "win32")).toEqual({
      file: cmd,
      args: ["/d", "/s", "/c", command],
    });
    expect(scriptShellCommand({ file: "powershell.exe", args: [] }, command, "win32")).toEqual({
      file: "powershell.exe",
      args: ["-NoLogo", "-Command", command],
    });
    expect(
      scriptShellCommand(
        { file: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: [] },
        command,
        "win32",
      ).args,
    ).toEqual(["-NoLogo", "-Command", command]);
  });

  it("leaves the shell it was given unchanged", () => {
    const shell = { file: "/bin/zsh", args: ["-l"] };
    scriptShellCommand(shell, command, "darwin");
    expect(shell).toEqual({ file: "/bin/zsh", args: ["-l"] });
  });
});

describe("terminalEnv", () => {
  it("keeps the user's environment and drops what belongs to Poseidon", () => {
    const env = terminalEnv(
      {
        HOME: "/Users/someone",
        PATH: "/usr/bin:/bin",
        LANG: "de_DE.UTF-8",
        ELECTRON_RUN_AS_NODE: "1",
        POSEIDON_HOME: "/Users/someone/.poseidon",
        POSEIDON_PORT: "4321",
        POSEIDON_DEV: "1",
        UNSET: undefined,
      },
      "darwin",
    );
    expect(env).toEqual({
      HOME: "/Users/someone",
      PATH: "/usr/bin:/bin",
      LANG: "de_DE.UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "Poseidon",
    });
  });

  it("does not change the environment it was given", () => {
    const base = { POSEIDON_HOME: "/x", TERM: "dumb" };
    terminalEnv(base, "linux");
    expect(base).toEqual({ POSEIDON_HOME: "/x", TERM: "dumb" });
  });

  it("overrides the emulator variables the server itself inherited", () => {
    const env = terminalEnv({ TERM: "dumb", TERM_PROGRAM: "vscode", COLORTERM: "" }, "linux");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.TERM_PROGRAM).toBe("Poseidon");
    expect(env.COLORTERM).toBe("truecolor");
  });

  it("defaults LANG to UTF-8 on macOS only, and only when it is unset or empty", () => {
    expect(terminalEnv({}, "darwin").LANG).toBe("en_US.UTF-8");
    expect(terminalEnv({ LANG: "" }, "darwin").LANG).toBe("en_US.UTF-8");
    expect(terminalEnv({ LANG: "C" }, "darwin").LANG).toBe("C");
    expect(terminalEnv({}, "linux").LANG).toBeUndefined();
  });

  it("matches the dropped keys case-insensitively on Windows only", () => {
    expect(
      terminalEnv({ Poseidon_Home: "/x", electron_run_as_node: "1" }, "win32"),
    ).not.toHaveProperty("Poseidon_Home");
    expect(terminalEnv({ electron_run_as_node: "1" }, "win32")).not.toHaveProperty(
      "electron_run_as_node",
    );
    expect(terminalEnv({ poseidon_home: "/x" }, "linux")).toHaveProperty("poseidon_home", "/x");
  });

  it("scrubs the AppImage runtime from the environment and the search paths", () => {
    const env = terminalEnv(
      {
        APPIMAGE: "/home/u/Poseidon.AppImage",
        APPDIR: "/tmp/.mount_OpenAdX",
        ARGV0: "Poseidon.AppImage",
        OWD: "/home/u",
        PATH: "/tmp/.mount_OpenAdX/usr/bin:/usr/local/bin:/usr/bin",
        LD_LIBRARY_PATH: "/tmp/.mount_OpenAdX/usr/lib",
        XDG_DATA_DIRS: "/tmp/.mount_OpenAdX/usr/share:/usr/share",
        HOME: "/home/u",
      },
      "linux",
    );
    expect(env).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      XDG_DATA_DIRS: "/usr/share",
      HOME: "/home/u",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "Poseidon",
    });
  });

  it("leaves ARGV0 and OWD alone outside an AppImage", () => {
    const env = terminalEnv({ ARGV0: "zsh", OWD: "/home/u", PATH: "/usr/bin" }, "linux");
    expect(env.ARGV0).toBe("zsh");
    expect(env.OWD).toBe("/home/u");
    expect(env.PATH).toBe("/usr/bin");
  });
});

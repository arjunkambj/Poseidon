import {
  Anthropic,
  ClaudeCode,
  ClaudeCodeColor,
  Code,
  Codex,
  CodexColor,
  Cursor,
  Deepseek,
  FolderOpen,
  Google,
  Kimi,
  Meta,
  Mistral,
  Nvidia,
  Openai,
  Qwen,
  Server,
  Terminal,
  Windsurf,
  Xai,
  Zai,
  ZedColor,
} from "@honeyicons/react";
import type { DetectedEditor, EditorId, EditorKind } from "@poseidon/contracts/editors";
import { describe, expect, it } from "vitest";

import {
  connectorIconFor,
  editorIconFor,
  harnessLogoFor,
  providerKey,
  providerMarkFor,
} from "./brand-icons";

describe("connectorIconFor", () => {
  it("draws a harness's monochrome logo when its key names one", () => {
    expect(connectorIconFor("claude-code")).toBe(ClaudeCode);
    expect(connectorIconFor("codex")).toBe(Codex);
  });

  it("maps the generic keys a connector may name", () => {
    expect(connectorIconFor("terminal")).toBe(Terminal);
    expect(connectorIconFor("server")).toBe(Server);
  });

  it("falls back to the server glyph for an unknown or missing key", () => {
    expect(connectorIconFor("unheard-of")).toBe(Server);
    expect(connectorIconFor("toString")).toBe(Server);
    expect(connectorIconFor(undefined)).toBe(Server);
  });
});

describe("harnessLogoFor", () => {
  it("gives the colour logo for a key that names one", () => {
    expect(harnessLogoFor("claude-code")).toBe(ClaudeCodeColor);
    expect(harnessLogoFor("codex")).toBe(CodexColor);
  });

  it("gives nothing for a generic, unknown or missing key, so the monogram stays", () => {
    expect(harnessLogoFor("terminal")).toBeUndefined();
    expect(harnessLogoFor("server")).toBeUndefined();
    expect(harnessLogoFor("unheard-of")).toBeUndefined();
    expect(harnessLogoFor(undefined)).toBeUndefined();
  });
});

describe("editorIconFor", () => {
  const app = (id: EditorId, kind: EditorKind): DetectedEditor => ({
    id,
    label: id,
    kind,
    supportsLine: false,
  });

  it("draws the logo of an app Honeyicons has one for", () => {
    expect(editorIconFor(app("cursor", "editor"))).toBe(Cursor);
    expect(editorIconFor(app("windsurf", "editor"))).toBe(Windsurf);
    expect(editorIconFor(app("zed", "editor"))).toBe(ZedColor);
  });

  it("falls back to a glyph for the app's kind", () => {
    expect(editorIconFor(app("vscode", "editor"))).toBe(Code);
    expect(editorIconFor(app("vscode-insiders", "editor"))).toBe(Code);
    expect(editorIconFor(app("sublime", "editor"))).toBe(Code);
    expect(editorIconFor(app("finder", "file-manager"))).toBe(FolderOpen);
    expect(editorIconFor(app("terminal", "terminal"))).toBe(Terminal);
  });
});

describe("providerKey", () => {
  it("reads the provider from the id's prefix, lowercased and without punctuation", () => {
    expect(providerKey("qwen/qwen3.8-max", "Open Source")).toBe("qwen");
    expect(providerKey("z-ai/glm-5.3-flash", "Open Source")).toBe("zai");
    expect(providerKey("zai-org/glm-5.3", "Open Source")).toBe("zaiorg");
    expect(providerKey("google/gemini-3.8-flash", "Google")).toBe("google");
  });

  it("falls back to the family when the id has no prefix", () => {
    expect(providerKey("gpt-5.5", "OpenAI")).toBe("openai");
    expect(providerKey("some-model", "Anthropic")).toBe("anthropic");
    expect(providerKey("/odd", "Open Source")).toBe("opensource");
  });
});

describe("providerMarkFor", () => {
  // Every prefix and family header in the recorded Command Code list
  // (packages/testkit/fixtures/cmd/probe/list-models.stdout.txt), and the
  // other spellings a provider goes by.
  it.each([
    ["deepseek/deepseek-v4-pro", "Open Source", Deepseek],
    ["moonshotai/kimi-k3", "Open Source", Kimi],
    ["kimi/k2", "Open Source", Kimi],
    ["z-ai/glm-5.3-flash", "Open Source", Zai],
    ["zai-org/glm-5.3", "Open Source", Zai],
    ["zai/glm-5", "Open Source", Zai],
    ["qwen/qwen3.8-max", "Open Source", Qwen],
    ["nvidia/nemotron-3-ultra-550b-a55b", "Open Source", Nvidia],
    ["google/gemini-3.8-flash", "Google", Google],
    ["gemini/flash", "Open Source", Google],
    ["meta/muse-spark-1.3-contributor", "Open Source", Meta],
    ["xai/grok-5", "Open Source", Xai],
    ["mistral/devstral", "Open Source", Mistral],
    ["mistralai/devstral", "Open Source", Mistral],
    ["some-model", "Anthropic", Anthropic],
    ["gpt-5.5", "OpenAI", Openai],
  ])("marks %s (%s)", (id, family, mark) => {
    expect(providerMarkFor(providerKey(id, family))).toBe(mark);
  });

  it.each([
    ["minimaxai/minimax-m3", "Open Source"],
    ["xiaomi/mimo-v2.5-pro", "Open Source"],
    ["meituan/longcat-2.0:free", "Open Source"],
    ["stepfun/step-3.7-flash", "Open Source"],
    ["tencent/hy4-preview", "Open Source"],
    ["thinkingmachines/inkling", "Open Source"],
    ["poolside/laguna-s-2.1-free", "Open Source"],
    ["inclusionai/ling-3.0-flash-sante:free", "Open Source"],
    ["sakana/fugu-ultra", "Sakana"],
    ["some-model", "Open Source"],
  ])("leaves %s (%s) unmarked", (id, family) => {
    expect(providerMarkFor(providerKey(id, family))).toBeUndefined();
  });

  it("leaves a missing or inherited key unmarked", () => {
    expect(providerMarkFor(undefined)).toBeUndefined();
    expect(providerMarkFor("constructor")).toBeUndefined();
  });
});

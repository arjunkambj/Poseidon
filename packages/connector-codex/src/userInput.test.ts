/**
 * A composer turn as `turn/start`'s input: the text with its mentions,
 * references and named files, then each image as a `localImage` — and which
 * attachments are images is what their bytes say.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { makeThreadId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "vitest";

import { stageAttachments } from "./attachments";
import { userInput } from "./userInput";

const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4IycHRAwQCgAhpgRhTxp8CQAAAABJRU5ErkJggg==",
  "base64",
);

describe("userInput", () => {
  it("writes the text, the mentions as @path, and the named files in one text input", () => {
    expect(
      userInput(
        { text: "look", attachments: [], mentions: ["src/a.ts"] },
        { images: ["/tmp/x.png"], promptLines: ["Attachment: /tmp/notes.txt"] },
      ),
    ).toEqual([
      { type: "text", text: "look\n@src/a.ts\nAttachment: /tmp/notes.txt", text_elements: [] },
      { type: "localImage", path: "/tmp/x.png" },
    ]);
  });

  it("names each skill, then each plugin, once, before the named files", () => {
    expect(
      userInput(
        {
          text: "go $tidy",
          attachments: [],
          mentions: [],
          references: [
            { kind: "plugin", name: "browser" },
            { kind: "skill", name: "tidy" },
            { kind: "skill", name: "tidy" },
          ],
        },
        { images: [], promptLines: ["Attachment: /tmp/notes.txt"] },
      ),
    ).toEqual([
      {
        type: "text",
        text: 'go $tidy\nUse the "tidy" skill.\nUse the "browser" plugin.\nAttachment: /tmp/notes.txt',
        text_elements: [],
      },
    ]);
  });
});

describe("stageAttachments", () => {
  it("sends an image by its path, and copies any other file in to name it", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-attach-"));
    const image = NodePath.join(dir, "shot.bin");
    NodeFS.writeFileSync(image, RED_PNG);
    const notes = NodePath.join(dir, "notes.txt");
    NodeFS.writeFileSync(notes, "hello");
    const attachmentsDir = NodePath.join(dir, "attachments");
    const threadId = makeThreadId();

    const staged = await stageAttachments({
      attachmentsDir,
      threadId,
      attachments: [
        { path: image, name: "shot.bin" },
        { path: notes, mime: "text/plain", name: "notes.txt" },
      ],
    });
    expect(staged.images).toEqual([image]);
    expect(staged.warnings).toEqual([]);
    const copied = NodePath.join(attachmentsDir, threadId, "1-notes.txt");
    expect(staged.promptLines).toEqual([`Attachment (text/plain): ${copied}`]);
    expect(NodeFS.readFileSync(copied, "utf8")).toBe("hello");
  });

  it("names a file it cannot read, and says so, rather than failing the turn", async () => {
    const missing = NodePath.join(NodeOS.tmpdir(), "codex-missing-attachment.png");
    const staged = await stageAttachments({
      attachmentsDir: NodeOS.tmpdir(),
      threadId: makeThreadId(),
      attachments: [{ path: missing }],
    });
    expect(staged.images).toEqual([]);
    expect(staged.promptLines).toEqual([`Attachment: ${missing}`]);
    expect(staged.warnings).toHaveLength(1);
  });
});

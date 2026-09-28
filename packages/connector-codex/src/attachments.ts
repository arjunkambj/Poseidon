/**
 * A turn's attachments, as the app-server takes them.
 *
 * An image goes to the model as itself: a `localImage` input naming the
 * file, which the CLI reads and sends along. Whether a file is an image is
 * what its own magic bytes say (`@poseidon/shared/imageBytes`) — never the
 * name or the type the reference claims — and one larger than
 * `MAX_ATTACHMENT_BYTES` is not sent as one.
 *
 * Any other file is named by path, the way Command Code's are: it is put under
 * `<attachmentsDir>/<threadId>/`, and the prompt gets a line naming its
 * absolute path and media type, so the model reads it with its own tools. The
 * sandbox limits writes, not reads, so the directory needs no grant. Most
 * files are already there — the server stages a composer upload straight into
 * that directory — and one that is not is copied in.
 *
 * Nothing here fails the turn. A copy or a read that fails leaves the original
 * path in the prompt and a warning the session passes on, because a turn the
 * user asked for is better than no turn.
 */

import { copyFile, mkdir, open, stat } from "node:fs/promises";
import * as NodePath from "node:path";
import type { TurnInput } from "@poseidon/connector-sdk/definition";
import type { ThreadId } from "@poseidon/contracts/ids";
import {
  MAX_ATTACHMENT_BYTES,
  safeAttachmentName,
  sniffImageMediaType,
} from "@poseidon/shared/imageBytes";

type Attachment = TurnInput["attachments"][number];

export interface StagedAttachments {
  /** The images' absolute paths, in the order they were attached. */
  readonly images: ReadonlyArray<string>;
  /** One line per file named by path, appended to the prompt. */
  readonly promptLines: ReadonlyArray<string>;
  /** What could not be done; the session says each as a `session.warning`. */
  readonly warnings: ReadonlyArray<string>;
}

const NOTHING: StagedAttachments = { images: [], promptLines: [], warnings: [] };

/** Enough of a file's head for every signature `sniffImageMediaType` knows. */
const SNIFF_BYTES = 32;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const nameOf = (attachment: Attachment): string =>
  attachment.name ?? NodePath.basename(attachment.path);

/** `child` is inside `parent`, compared on resolved paths. */
const isInside = (parent: string, child: string): boolean =>
  NodePath.resolve(child).startsWith(NodePath.resolve(parent) + NodePath.sep);

/**
 * A name for a copy that cannot collide with another attachment's and cannot
 * escape the directory: the content hash when the reference carries one, the
 * attachment's place otherwise.
 */
const copyNameFor = (attachment: Attachment, index: number): string => {
  const prefix = attachment.sha256 === undefined ? `${index}` : attachment.sha256.slice(0, 12);
  return `${prefix}-${safeAttachmentName(nameOf(attachment))}`;
};

/**
 * What the model reads. The media type is stated because a path alone does
 * not say what the file is, and the model has to choose to open it.
 */
const attachmentLine = (path: string, mime: string | undefined): string =>
  mime === undefined ? `Attachment: ${path}` : `Attachment (${mime}): ${path}`;

/** The file is an image the model can be shown: small enough, and its bytes say so. */
const isImage = async (path: string): Promise<boolean> => {
  if ((await stat(path)).size > MAX_ATTACHMENT_BYTES) return false;
  const file = await open(path, "r");
  try {
    const head = new Uint8Array(SNIFF_BYTES);
    const { bytesRead } = await file.read(head, 0, SNIFF_BYTES, 0);
    return sniffImageMediaType(head.subarray(0, bytesRead)) !== null;
  } finally {
    await file.close();
  }
};

/** Every attachment of a turn, as image paths and prompt lines. */
export const stageAttachments = async (input: {
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  readonly attachments: ReadonlyArray<Attachment>;
}): Promise<StagedAttachments> => {
  if (input.attachments.length === 0) return NOTHING;
  const directory = NodePath.join(NodePath.resolve(input.attachmentsDir), input.threadId);
  const images: Array<string> = [];
  const promptLines: Array<string> = [];
  const warnings: Array<string> = [];

  for (const [index, attachment] of input.attachments.entries()) {
    const absolute = NodePath.resolve(attachment.path);
    try {
      if (await isImage(absolute)) {
        images.push(absolute);
        continue;
      }
    } catch (cause) {
      warnings.push(`could not read the attachment ${nameOf(attachment)}: ${messageOf(cause)}`);
      promptLines.push(attachmentLine(absolute, attachment.mime));
      continue;
    }
    if (isInside(directory, absolute)) {
      // The server already staged it; copying again would only duplicate it.
      promptLines.push(attachmentLine(absolute, attachment.mime));
      continue;
    }
    const target = NodePath.join(directory, copyNameFor(attachment, index));
    try {
      await mkdir(directory, { recursive: true });
      await copyFile(absolute, target);
      promptLines.push(attachmentLine(target, attachment.mime));
    } catch (cause) {
      warnings.push(`could not copy the attachment ${nameOf(attachment)}: ${messageOf(cause)}`);
      promptLines.push(attachmentLine(absolute, attachment.mime));
    }
  }

  return { images, promptLines, warnings };
};

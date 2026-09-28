/**
 * Reading what a harness wrote back, leniently.
 *
 * A harness that enforces the JSON schema answers the object alone; one that
 * does not may wrap it in a code fence, put a sentence before it, or ignore
 * the shape and write plain text. So the answer is trimmed, a fence is
 * stripped and the first `{` to the last `}` is tried as JSON. An object found
 * that way is the answer, and without the field asked for it is none. When
 * there is no object, the text itself is used: its first line is the subject
 * or title and the rest the body. Null when nothing usable is left.
 */

/** The text inside a Markdown code fence, when the whole answer is one. */
const unfenced = (text: string): string => {
  const match = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(text.trim());
  return (match?.[1] ?? text).trim();
};

/** The JSON object the answer holds, if any. */
const jsonObject = (text: string): Record<string, unknown> | null => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const stringField = (object: Record<string, unknown> | null, key: string): string | null => {
  const value = object?.[key];
  return typeof value === "string" ? value : null;
};

/**
 * One line: surrounding space, a leading `#` or `Subject:` label, wrapping
 * quotes and a trailing period removed — twice, for `"Fix it".`.
 */
const oneLine = (text: string): string => {
  let line = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^(subject|title)\s*:\s*/i, "");
  for (let pass = 0; pass < 2; pass += 1) {
    line = line
      .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
      .replace(/\.+$/, "")
      .trim();
  }
  return line;
};

/** The first non-blank line and everything after it. */
const splitLines = (text: string): { readonly head: string; readonly rest: string } => {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() !== "");
  return index === -1
    ? { head: "", rest: "" }
    : { head: lines[index] ?? "", rest: lines.slice(index + 1).join("\n") };
};

/**
 * `head` and `body` read from the answer. When it holds a JSON object, only
 * the object counts: `headKey` and `body`, null when `headKey` is missing or
 * empty. Otherwise the text is read as plain lines.
 */
const headAndBody = (
  text: string,
  headKey: string,
): { readonly head: string; readonly body: string } | null => {
  const cleaned = unfenced(text);
  const object = jsonObject(cleaned);
  if (object !== null) {
    const head = oneLine(stringField(object, headKey) ?? "");
    return head === "" ? null : { head, body: (stringField(object, "body") ?? "").trim() };
  }
  const { head, rest } = splitLines(cleaned);
  const line = oneLine(head);
  return line === "" ? null : { head: line, body: rest.trim() };
};

/** A commit message's subject and body, the subject on one line with no trailing period. */
export const parseCommitMessage = (
  text: string,
): { readonly subject: string; readonly body: string } | null => {
  const parsed = headAndBody(text, "subject");
  return parsed === null ? null : { subject: parsed.head, body: parsed.body };
};

/** A pull request's title and body. */
export const parsePullRequest = (
  text: string,
): { readonly title: string; readonly body: string } | null => {
  const parsed = headAndBody(text, "title");
  return parsed === null ? null : { title: parsed.head, body: parsed.body };
};

/** The longest thread title kept, whatever the model wrote. */
const TITLE_KEEP = 80;

/** A thread title: one line, no trailing period, at most `TITLE_KEEP` characters. */
export const parseTitle = (text: string): string | null => {
  const parsed = headAndBody(text, "title");
  if (parsed === null) {
    return null;
  }
  const title = parsed.head.replace(/[.!]+$/, "").trim();
  if (title.length <= TITLE_KEEP) {
    return title === "" ? null : title;
  }
  const cut = title.slice(0, TITLE_KEEP);
  const space = cut.lastIndexOf(" ");
  return (space > TITLE_KEEP / 2 ? cut.slice(0, space) : cut).trim();
};

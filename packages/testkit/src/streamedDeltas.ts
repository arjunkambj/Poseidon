/**
 * A capture's streamed content blocks, scrubbed as the text their deltas join
 * into. The recorder scrubs each frame on its own, and a name split across
 * two deltas is in neither; `finalizeStdioRecording` runs this first.
 */

import type { RecordedFrame } from "./recording";

/** Where a streamed content block's delta keeps its text, by the delta's type. */
const DELTA_TEXT_KEY: Readonly<Record<string, string>> = {
  text_delta: "text",
  thinking_delta: "thinking",
  input_json_delta: "partial_json",
};

interface DeltaChunk {
  readonly frame: number;
  readonly text: string;
}

interface StreamedBlock {
  /** The block among its frames: where it travelled, whose stream, its index. */
  readonly block: string;
  /** Its delta's text, or undefined for the event that opens the block. */
  readonly text?: string;
}

/** A frame that opens a streamed content block, or carries one's delta text. */
const streamedBlockOf = (frame: RecordedFrame): StreamedBlock | undefined => {
  const data = frame.data as {
    type?: unknown;
    parent_tool_use_id?: unknown;
    event?: { type?: unknown; index?: unknown; delta?: Record<string, unknown> };
  } | null;
  if (data?.type !== "stream_event") return;
  const block = JSON.stringify([
    frame.dir,
    frame.channel,
    data.parent_tool_use_id,
    data.event?.index,
  ]);
  if (data.event?.type === "content_block_start") return { block };
  if (data.event?.type !== "content_block_delta") return;
  const key = DELTA_TEXT_KEY[String(data.event.delta?.type)];
  const text = key === undefined ? undefined : data.event.delta?.[key];
  return typeof text === "string" ? { block, text } : undefined;
};

/**
 * A run of one block's deltas, as the frames were captured, scrubbed as the
 * text they join into. A boundary between two chunks is kept where scrubbing
 * either side of it apart gives what scrubbing them together does; where it
 * does not, a name the scrubber knows was split there, and the chunks on both
 * sides become one, carried by the first of them and the rest left empty.
 * Chunks no name was split across come back as they were, for the frame's own
 * scrubbing.
 */
const scrubbedRun = (
  chunks: ReadonlyArray<string>,
  text: (value: string) => string,
): ReadonlyArray<string> => {
  const joined = chunks.join("");
  if (text(joined) === chunks.map(text).join("")) return chunks;
  const out = chunks.map(() => "");
  let first = 0;
  let start = 0;
  let end = 0;
  chunks.forEach((chunk, index) => {
    end += chunk.length;
    const head = joined.slice(start, end);
    const rest = joined.slice(end);
    if (index < chunks.length - 1 && text(head) + text(rest) !== text(head + rest)) return;
    out[first] = text(head);
    first = index + 1;
    start = end;
  });
  return out;
};

/**
 * Captured frames with every streamed content block scrubbed as its joined
 * text, before each frame is scrubbed on its own: a model streams a name the
 * scrubber knows, a connector's label or a path, split across two deltas as
 * readily as inside one, and neither half is the name.
 */
export const scrubDeltaRuns = (
  frames: ReadonlyArray<RecordedFrame>,
  text: (value: string) => string,
): ReadonlyArray<RecordedFrame> => {
  const runs: Array<Array<DeltaChunk>> = [];
  const open = new Map<string, Array<DeltaChunk>>();
  frames.forEach((frame, index) => {
    const streamed = streamedBlockOf(frame);
    if (streamed === undefined) return;
    let run = open.get(streamed.block);
    if (streamed.text === undefined || run === undefined) {
      run = [];
      runs.push(run);
      open.set(streamed.block, run);
    }
    if (streamed.text !== undefined) run.push({ frame: index, text: streamed.text });
  });
  const replaced = new Map<number, string>();
  for (const run of runs) {
    const scrubbed = scrubbedRun(
      run.map((chunk) => chunk.text),
      text,
    );
    run.forEach((chunk, index) => {
      if (scrubbed[index] !== chunk.text) replaced.set(chunk.frame, scrubbed[index]!);
    });
  }
  if (replaced.size === 0) return frames;
  return frames.map((frame, index) => {
    const value = replaced.get(index);
    if (value === undefined) return frame;
    const data = frame.data as { event: { delta: Record<string, unknown> } };
    const key = DELTA_TEXT_KEY[String(data.event.delta.type)]!;
    return {
      ...frame,
      data: { ...data, event: { ...data.event, delta: { ...data.event.delta, [key]: value } } },
    };
  });
};

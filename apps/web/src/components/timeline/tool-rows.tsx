/**
 * The compact work rows: reasoning, command_execution, tool_call,
 * mcp_tool_call and web_search. Each is an icon + one-line label with an
 * expandable detail body; disclosure state is keyed by item id in
 * `rowDisclosureAtom`. Tool rows follow the name with a short target (see
 * `toolTarget`), and a target that is a file the workspace confirms is a file
 * chip; the agent's in-app browser calls read as what they did to the page
 * (`browserToolLabel`).
 */

import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import type { ReactNode } from "react";

import { browserToolLabel } from "@/components/timeline/browser-tool";
import { PathChip, PathChipsProvider } from "@/components/timeline/path-chips";
import { DisclosureRow, JsonBlock, MonoBlock } from "@/components/timeline/row-shell";
import { FindText } from "@/components/timeline/thread-find-context";
import { toolPathTarget, toolTarget } from "@/components/timeline/tool-target";
import { cn } from "@/lib/utils";
import { Globe, Hammer, Lightbulb, Server, Terminal } from "@honeyicons/react";

/** First line of a value for a row label — strings verbatim, objects compact. */
const preview = (value: unknown, max = 80): string | undefined => {
  if (typeof value === "string") {
    const line = value.trim().split("\n", 1)[0];
    return line.length > max ? `${line.slice(0, max)}…` : line;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  try {
    const text = JSON.stringify(value);
    if (text === undefined) {
      return undefined;
    }
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return undefined;
  }
};

const field = (input: unknown, key: string): unknown =>
  typeof input === "object" && input !== null && key in input
    ? (input as Record<string, unknown>)[key]
    : undefined;

/** The target after a tool's name, muted so the name leads — or its file chip. */
function ToolTarget({ input }: { input: unknown }) {
  const target = toolTarget(input);
  if (target === undefined) {
    return null;
  }
  const text = (
    <span className="ml-1.5 font-mono text-xs text-muted-foreground">
      <FindText text={target} />
    </span>
  );
  const path = toolPathTarget(input);
  return path === undefined ? text : <PathChip path={path} fallback={text} className="ml-1.5" />;
}

/**
 * Asks the workspace about the file a tool names, for `ToolTarget`. A row with
 * such a file names its trigger, since the chip cannot sit inside it.
 */
function ToolPathScope({
  input,
  children,
}: {
  input: unknown;
  children: (triggerLabel: string | undefined) => ReactNode;
}) {
  const path = toolPathTarget(input);
  return (
    <PathChipsProvider candidates={path === undefined ? [] : [path]}>
      {children(path)}
    </PathChipsProvider>
  );
}

function ToolPayload({ input, output }: { input: unknown; output: unknown }) {
  return (
    <div className="flex flex-col gap-2">
      {input !== undefined ? (
        <div>
          <div className="mb-1 type-micro text-muted-foreground">Input</div>
          <JsonBlock value={input} />
        </div>
      ) : null}
      {output !== undefined ? (
        <div>
          <div className="mb-1 type-micro text-muted-foreground">Output</div>
          <JsonBlock value={output} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A reasoning row, which opens onto what the model thought. A harness can
 * report that it thought without saying what, so a row with no text is a
 * plain line with nothing to open.
 */
export function ReasoningRow({ item }: { item: ItemSnapshot }) {
  const inProgress = item.status === "in_progress";
  const text = item.text ?? "";
  return (
    <DisclosureRow
      rowId={item.itemId}
      icon={Lightbulb}
      label={inProgress ? "Thinking…" : "Reasoning"}
      status={item.status}
    >
      {text.trim() === "" ? null : (
        <p className="whitespace-pre-wrap">
          <FindText text={text} />
        </p>
      )}
    </DisclosureRow>
  );
}

function ExitCode({ code }: { code: number | undefined }) {
  if (code === undefined) {
    return null;
  }
  return (
    <span
      className={cn(
        "ml-1 shrink-0 rounded-sm px-1 font-mono text-xs",
        code === 0 ? "bg-hover text-muted-foreground" : "bg-removed-bg text-removed",
      )}
    >
      {code === 0 ? "ok" : `exit ${code}`}
    </span>
  );
}

export function CommandExecutionRow({ item }: { item: ItemSnapshot }) {
  const command = item.command;
  const cmd = command?.cmd ?? item.text ?? "command";
  const output = command?.output;
  return (
    <DisclosureRow
      rowId={item.itemId}
      icon={Terminal}
      label={
        <span className="font-mono text-xs">
          <FindText text={cmd} />
        </span>
      }
      status={item.status}
      meta={
        <>
          {command?.cwd ? (
            <span className="shrink-0 type-micro text-muted-foreground">{command.cwd}</span>
          ) : null}
          <ExitCode code={command?.exitCode} />
        </>
      }
    >
      {output !== undefined && output !== "" ? <MonoBlock>{output}</MonoBlock> : null}
    </DisclosureRow>
  );
}

export function ToolCallRow({ item }: { item: ItemSnapshot }) {
  const tool = item.tool;
  const name = tool?.name ?? item.text ?? "tool call";
  return (
    <ToolPathScope input={tool?.input}>
      {(path) => (
        <DisclosureRow
          rowId={item.itemId}
          icon={Hammer}
          label={
            <>
              <FindText text={name} />
              <ToolTarget input={tool?.input} />
            </>
          }
          triggerLabel={path === undefined ? undefined : `${name} ${path}`}
          status={item.status}
        >
          {tool !== undefined ? <ToolPayload input={tool.input} output={tool.output} /> : undefined}
        </DisclosureRow>
      )}
    </ToolPathScope>
  );
}

export function McpToolCallRow({ item }: { item: ItemSnapshot }) {
  const tool = item.tool;
  const name = tool?.name ?? item.text ?? "mcp tool";
  const browser = browserToolLabel(name, tool?.input);
  if (browser !== null) {
    return (
      <DisclosureRow
        rowId={item.itemId}
        icon={Globe}
        label={<FindText text={browser} />}
        status={item.status}
      >
        {tool !== undefined ? <ToolPayload input={tool.input} output={tool.output} /> : undefined}
      </DisclosureRow>
    );
  }
  return (
    <ToolPathScope input={tool?.input}>
      {(path) => (
        <DisclosureRow
          rowId={item.itemId}
          icon={Server}
          label={
            <>
              {tool?.server !== undefined ? (
                <span className="mr-1 rounded-sm bg-hover px-1 font-mono text-xs">
                  {tool.server}
                </span>
              ) : null}
              <FindText text={name} />
              <ToolTarget input={tool?.input} />
            </>
          }
          triggerLabel={path === undefined ? undefined : `${name} ${path}`}
          status={item.status}
        >
          {tool !== undefined ? <ToolPayload input={tool.input} output={tool.output} /> : undefined}
        </DisclosureRow>
      )}
    </ToolPathScope>
  );
}

export function WebSearchRow({ item }: { item: ItemSnapshot }) {
  const query = preview(field(item.tool?.input, "query")) ?? item.text ?? "web search";
  const hasPayload = item.tool !== undefined;
  const body: ReactNode = hasPayload ? (
    <ToolPayload input={item.tool?.input} output={item.tool?.output} />
  ) : undefined;
  return (
    <DisclosureRow
      rowId={item.itemId}
      icon={Globe}
      label={<FindText text={query} />}
      status={item.status}
    >
      {body}
    </DisclosureRow>
  );
}

/**
 * Claude Code's tool vocabulary, mapped onto Poseidon's approval model: which
 * kind of permission a call asks for, the MCP server and tool it names, the
 * pattern its "allow always" starts from — in Poseidon's own pattern vocabulary
 * (`@poseidon/shared/permissionPattern`, docs/architecture.md "Permissions"),
 * never the CLI's — and the line the card shows.
 *
 * The request is what the permission ladder reads, so its `input` is the
 * call's input with the one field the ladder would not find under its usual
 * names put where it looks: NotebookEdit names its file `notebook_path`, and
 * the ladder reads `path`, `file_path`, `filePath` or `file`. Without that a
 * notebook under `.ssh` would be a write with no path, and the sensitive-path
 * rung would never see it.
 */

import type { ApprovalKind } from "@poseidon/contracts/enums";
import { makeRequestId } from "@poseidon/contracts/ids";
import type { ApprovalRequest, McpToolRef } from "@poseidon/contracts/runtime";

/** The tool the model puts a question to the user with. */
export const ASK_USER_QUESTION = "AskUserQuestion";
/** The tool a plan turn hands its plan over with. */
export const EXIT_PLAN_MODE = "ExitPlanMode";

/**
 * The CLI's own bookkeeping tools, which CLI 2.1.280 never asks permission
 * for: they define no permission check of their own, so the CLI allows them
 * in every mode, and none runs a command, touches a file or leaves the
 * working directory. Read from the CLI's bundle:
 *
 * - Agent (Task is its older name) delegates to a subagent. The subagent's
 *   own calls still reach the hook one by one. The CLI asks about a
 *   delegation only under its auto mode's classifier, which Poseidon never
 *   selects;
 * - TodoWrite and TaskCreate, TaskGet, TaskUpdate, TaskList keep the model's
 *   checklist; TaskStop stops a background task the model started;
 * - ToolSearch loads the schemas of deferred tools;
 * - EnterPlanMode moves the CLI into plan mode, which only narrows what runs.
 *
 * Skill is not one: the CLI asks before running a skill no rule allows. Nor
 * are Monitor, the worktree, cron and remote-trigger tools, which run commands
 * or change the working directory.
 */
export const NO_PERMISSION_TOOLS: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
  "TodoWrite",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "TaskStop",
  "ToolSearch",
  "EnterPlanMode",
]);

const SHELL_TOOLS = new Set(["Bash"]);
const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** Which kind of permission a tool call asks for. */
export const approvalKindFor = (toolName: string): ApprovalKind => {
  if (SHELL_TOOLS.has(toolName)) return "command";
  if (WRITE_TOOLS.has(toolName)) return "file_write";
  if (READ_TOOLS.has(toolName)) return "file_read";
  if (WEB_TOOLS.has(toolName)) return "web";
  if (mcpToolFor(toolName) !== undefined) return "mcp_tool";
  return "other";
};

/**
 * The server and tool of an MCP call. The CLI names them
 * `mcp__<server>__<tool>`; the server is the first segment, and a tool name
 * may itself contain `__`.
 */
export const mcpToolFor = (toolName: string): McpToolRef | undefined => {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match === null ? undefined : { server: match[1]!, tool: match[2]! };
};

const asInput = (input: unknown): Readonly<Record<string, unknown>> =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

const field = (
  input: Readonly<Record<string, unknown>>,
  ...keys: ReadonlyArray<string>
): string | undefined => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
};

/** The path a file tool is about, whichever name the tool gives it. */
const pathOf = (input: Readonly<Record<string, unknown>>): string | undefined =>
  field(input, "file_path", "path", "notebook_path", "filePath", "file");

/** The input as the ladder should read it: NotebookEdit's path where it looks. */
export const ladderInputFor = (toolName: string, input: unknown): unknown => {
  const record = asInput(input);
  const notebook = field(record, "notebook_path");
  return toolName === "NotebookEdit" &&
    notebook !== undefined &&
    field(record, "file_path") === undefined
    ? { ...record, file_path: notebook }
    : input;
};

/**
 * The editable pattern the card's "allow always" starts from:
 * `Shell(<first word> *)`, `Edit(<path>)` for every kind of write,
 * `Read(<path>)`, `Fetch(<url or query>)`, `Mcp(<server>.<tool>)` — or the
 * bare tool name when nothing narrower applies, such as a search with no path.
 */
export const patternSuggestionFor = (toolName: string, input: unknown): string => {
  const record = asInput(input);
  const path = pathOf(record);
  if (SHELL_TOOLS.has(toolName)) {
    const first = field(record, "command")?.trim().split(/\s+/)[0];
    return first === undefined || first === "" ? "Shell(*)" : `Shell(${first} *)`;
  }
  if (WRITE_TOOLS.has(toolName)) return `Edit(${path ?? "*"})`;
  if (READ_TOOLS.has(toolName)) return path === undefined ? toolName : `Read(${path})`;
  if (toolName === "WebFetch") return `Fetch(${field(record, "url") ?? "*"})`;
  if (toolName === "WebSearch") return `Fetch(${field(record, "query") ?? "*"})`;
  const mcp = mcpToolFor(toolName);
  if (mcp !== undefined) return `Mcp(${mcp.server}.${mcp.tool})`;
  return toolName;
};

/** At most this much of a command or pattern goes into the card's one line. */
const LINE_LIMIT = 200;

const clip = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT - 1)}…` : line;
};

/** The one human line the card leads with. */
export const descriptionFor = (toolName: string, input: unknown): string => {
  const record = asInput(input);
  const path = pathOf(record);
  const pattern = field(record, "pattern");
  switch (toolName) {
    case "Bash": {
      const command = field(record, "command");
      return command === undefined ? "Run a shell command" : `Run ${clip(command)}`;
    }
    case "Edit":
    case "MultiEdit":
      return path === undefined ? "Edit a file" : `Edit ${path}`;
    case "Write":
      return path === undefined ? "Write a file" : `Write ${path}`;
    case "NotebookEdit":
      return path === undefined ? "Edit a notebook" : `Edit the notebook ${path}`;
    case "Read":
      return path === undefined ? "Read a file" : `Read ${path}`;
    case "LS":
      return path === undefined ? "List a directory" : `List ${path}`;
    case "Glob":
      return pattern === undefined
        ? "Find files"
        : `Find files matching ${clip(pattern)}${path === undefined ? "" : ` in ${path}`}`;
    case "Grep":
      return pattern === undefined
        ? "Search files"
        : `Search for ${clip(pattern)}${path === undefined ? "" : ` in ${path}`}`;
    case "WebFetch": {
      const url = field(record, "url");
      return url === undefined ? "Fetch a web page" : `Fetch ${clip(url)}`;
    }
    case "WebSearch": {
      const query = field(record, "query");
      return query === undefined ? "Search the web" : `Search the web for ${clip(query)}`;
    }
  }
  const mcp = mcpToolFor(toolName);
  if (mcp !== undefined) return `Call ${mcp.tool} on the ${mcp.server} MCP server`;
  return toolName === "" ? "Use a tool" : `Use ${toolName}`;
};

/** One tool call as the permission ladder and the approval card read it. */
export const approvalRequestFor = (toolName: string, input: unknown): ApprovalRequest => {
  const name = toolName === "" ? "unknown" : toolName;
  const mcpTool = mcpToolFor(name);
  return {
    requestId: makeRequestId(),
    kind: approvalKindFor(name),
    toolName: name,
    input: ladderInputFor(name, input),
    patternSuggestion: patternSuggestionFor(name, input),
    ...(mcpTool === undefined ? {} : { mcpTool }),
    description: descriptionFor(toolName, input),
  };
};

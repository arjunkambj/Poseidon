/**
 * One subagent in the Agents tab: a 28px row — status, title and how long it
 * has run or ran — that opens onto what it was asked, where it stands and the
 * last few rows it produced. Open state lives in `rowDisclosureAtom` under
 * `agents:<itemId>`, apart from the timeline's own row for the same task, so
 * something outside the tab (the strip's View) can open an entry too.
 *
 * The recent rows are one line each, drawn here rather than with the
 * timeline's rows, which lean on the timeline's thread and find providers.
 */

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@poseidon/ui/components/collapsible";
import type { ItemSnapshot } from "@poseidon/contracts/runtime";
import type { ReactNode } from "react";

import { toolTarget } from "@/components/timeline/tool-target";
import { formatDurationMs, formatElapsed } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useRowDisclosure } from "@/state/ui";
import {
  type HoneyIcon,
  AlertTriangle,
  Bot,
  Chat,
  Check,
  ChevronRight,
  Edit,
  Globe,
  Hammer,
  Lightbulb,
  Server,
  Spinner,
  Terminal,
} from "@honeyicons/react";

import type { Subagent } from "./subagents";

/** The disclosure id of a subagent's entry in the Agents tab. */
const agentEntryRowId = (itemId: string): string => `agents:${itemId}`;

const markClass = "size-3.5 shrink-0";

function StateMark({ subagent }: { readonly subagent: Subagent }) {
  switch (subagent.state) {
    case "working":
      return <Spinner variant="bold" className={cn(markClass, "text-muted-foreground")} />;
    case "done":
      return <Check variant="bold" className={cn(markClass, "text-added")} />;
    case "failed":
      return <AlertTriangle variant="bold" className={cn(markClass, "text-destructive")} />;
  }
}

/** A task the turn settled under reads "Did not finish"; one its harness failed, "Failed". */
const agentStateLabel = (subagent: Subagent): string =>
  subagent.state === "working"
    ? "Working"
    : subagent.state === "done"
      ? "Done"
      : subagent.item.status === "in_progress"
        ? "Did not finish"
        : "Failed";

/** A working subagent's clock; only these tick. */
function Elapsed({ since }: { readonly since: number }) {
  const now = useNow(1_000);
  return <>{formatElapsed(now - since)}</>;
}

function RunTime({ subagent }: { readonly subagent: Subagent }) {
  if (subagent.state === "working") {
    return subagent.startedAt === undefined ? null : <Elapsed since={subagent.startedAt} />;
  }
  return subagent.durationMs === undefined ? null : <>{formatDurationMs(subagent.durationMs)}</>;
}

const firstLine = (text: string | undefined): string | undefined => {
  const line = text?.trim().split("\n", 1)[0]?.trim();
  return line === "" ? undefined : line;
};

/** A recent row's icon, name and short target. */
const recentLine = (
  item: ItemSnapshot,
): { readonly icon: HoneyIcon; readonly name: string; readonly target?: string } => {
  const target = (value: string | undefined) => (value === undefined ? {} : { target: value });
  switch (item.kind) {
    case "command_execution":
      return { icon: Terminal, name: "Ran", ...target(firstLine(item.command?.cmd)) };
    case "file_change":
      return { icon: Edit, name: "Edited", ...target(item.fileChange?.path) };
    case "mcp_tool_call":
      return {
        icon: Server,
        name: item.tool?.name ?? "MCP tool",
        ...target(toolTarget(item.tool?.input)),
      };
    case "web_search":
      return { icon: Globe, name: "Searched", ...target(firstLine(item.text)) };
    case "reasoning":
      return { icon: Lightbulb, name: "Thought" };
    case "assistant_message":
      return { icon: Chat, name: "Said", ...target(firstLine(item.text)) };
    case "task":
      return { icon: Bot, name: "Subagent", ...target(firstLine(item.text)) };
    default:
      return {
        icon: Hammer,
        name: item.tool?.name ?? item.kind.replaceAll("_", " "),
        ...target(toolTarget(item.tool?.input) ?? firstLine(item.text)),
      };
  }
};

function RecentRow({ item }: { readonly item: ItemSnapshot }) {
  const { icon: Glyph, name, target } = recentLine(item);
  return (
    <li className="flex h-6 min-w-0 items-center gap-2 text-muted-foreground">
      <Glyph variant="bold" className={cn(markClass, "text-foreground/85")} />
      <span className="shrink-0 text-foreground">{name}</span>
      {target === undefined ? null : (
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{target}</span>
      )}
      {item.status === "in_progress" ? (
        <Spinner variant="bold" className={cn(markClass, "ml-auto text-muted-foreground")} />
      ) : item.status === "failed" ? (
        <AlertTriangle variant="bold" className={cn(markClass, "ml-auto text-destructive")} />
      ) : null}
    </li>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

export function AgentEntry({ subagent }: { readonly subagent: Subagent }) {
  const [open, setOpen] = useRowDisclosure(agentEntryRowId(subagent.item.itemId));
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex h-7 items-center px-3 py-0.5 hover:bg-hover">
        <CollapsibleTrigger variant="summary" className="h-full">
          <ChevronRight
            variant="bold"
            className={cn(
              markClass,
              "text-muted-foreground transition-transform duration-150 ease-out",
              open && "rotate-90",
            )}
          />
          <StateMark subagent={subagent} />
          <span className="min-w-0 flex-1 truncate text-foreground">{subagent.title}</span>
          <span className="shrink-0 type-micro text-muted-foreground tabular-nums">
            <RunTime subagent={subagent} />
          </span>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 pt-1 pr-3 pb-2 pl-9 type-body">
          <dl className="flex flex-col gap-1">
            <Field label="Status">{agentStateLabel(subagent)}</Field>
            {subagent.state === "working" || subagent.durationMs === undefined ? null : (
              <Field label="Took">{formatDurationMs(subagent.durationMs)}</Field>
            )}
          </dl>
          {subagent.prompt === undefined ? null : (
            <p
              title={subagent.prompt}
              className="line-clamp-6 whitespace-pre-wrap text-muted-foreground"
            >
              {subagent.prompt}
            </p>
          )}
          {subagent.recent.length > 0 ? (
            <ul className="flex flex-col">
              {subagent.recent.map((item) => (
                <RecentRow key={item.itemId} item={item} />
              ))}
            </ul>
          ) : subagent.progress !== undefined && subagent.progress.trim() !== "" ? (
            <p className="line-clamp-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
              {subagent.progress.trim().split("\n").slice(-3).join("\n")}
            </p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

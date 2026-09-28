/**
 * The command palette's groups. Every entry has to land on something real — a
 * palette that navigates to a blank pane, or offers a command no surface on
 * this route answers, is worse than one that is missing the entry.
 */

import { useNavigate } from "@tanstack/react-router";

import {
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from "@poseidon/ui/components/command";
import type { ProjectId } from "@poseidon/contracts/ids";

import { paletteThreads, threadJumpCommand } from "@/components/Layout/palette-threads";
import { SETTINGS_PAGES } from "@/components/Layout/settings-sidebar";
import { useThreadTargets } from "@/components/sidebar/use-thread-targets";
import { CommandKbd } from "@/lib/shortcuts";
import { useCreateThread } from "@/lib/use-create-thread";
import { useProjects, useThreadList } from "@/state/hooks";
import { Add, Archive, Chat, Puzzle, Server, Sparkles, SquarePen } from "@honeyicons/react";

type GroupProps = { readonly onDone: () => void };

/** Each place also has a command, whose chord the row shows. */
const navigationItems = [
  { to: "/", icon: SquarePen, label: "New task", command: "thread.new" },
  { to: "/customize/skills", icon: Sparkles, label: "Skills", command: "skills.open" },
  { to: "/customize/mcp", icon: Server, label: "MCP servers", command: "mcp.open" },
  { to: "/customize/plugins", icon: Puzzle, label: "Plugins", command: "plugins.open" },
] as const;

/** A row's chord, right-aligned; nothing when the command is unbound. */
export function ItemShortcut({ command }: { readonly command?: string }) {
  if (command === undefined) {
    return null;
  }

  return (
    <CommandShortcut>
      <CommandKbd command={command} />
    </CommandShortcut>
  );
}

export function NavigationGroup({ onDone }: GroupProps) {
  const navigate = useNavigate();

  return (
    <CommandGroup heading="Navigation">
      {navigationItems.map((item) => (
        <CommandItem
          key={item.label}
          value={item.label}
          onSelect={() => {
            onDone();
            void navigate({ to: item.to });
          }}
        >
          <item.icon variant="bold" />
          {item.label}
          <ItemShortcut command={item.command} />
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/**
 * One entry per settings page, straight from the settings sidebar's own list,
 * so a page added there shows up here without a second edit. The value says
 * "Settings" too, so typing it finds every page.
 */
export function SettingsGroup({ onDone }: GroupProps) {
  const navigate = useNavigate();

  return (
    <>
      <CommandSeparator />
      <CommandGroup heading="Settings">
        {SETTINGS_PAGES.map((page) => (
          <CommandItem
            key={page.to}
            value={`Settings ${page.label}`}
            onSelect={() => {
              onDone();
              void navigate({ to: page.to });
            }}
          >
            <page.icon variant="bold" />
            {page.label}
            <ItemShortcut command={page.to === "/settings" ? "settings.open" : undefined} />
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  );
}

/**
 * A "New thread in …" entry per project, each starting a thread through the
 * one create flow. The project `thread.newInProject` would pick shows that
 * command's chord, which stands in for a command row of its own. The commands
 * — add project, toggle sidebar and the rest — are `PaletteCommands`.
 */
export function NewThreadGroup({ onDone }: GroupProps) {
  const projects = useProjects();
  const { create } = useCreateThread();
  const { newThreadProject } = useThreadTargets();

  if (projects.length === 0) {
    return null;
  }

  return (
    <>
      <CommandSeparator />
      <CommandGroup heading="New thread">
        {projects.map((project) => (
          <CommandItem
            key={project.projectId}
            value={`New thread in ${project.name}`}
            onSelect={() => {
              onDone();
              void create(project.projectId);
            }}
          >
            <Add variant="bold" />
            New thread in {project.name}
            <ItemShortcut
              command={
                project.projectId === newThreadProject?.projectId
                  ? "thread.newInProject"
                  : undefined
              }
            />
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  );
}

/**
 * The threads the palette can reach. A palette in a multi-thread app that
 * cannot find a thread is a menu, so the list comes from the live atoms.
 *
 * Archived threads are off the sidebar but stay reachable here, listed after
 * the live ones, marked, and matched by typing "archived". The first nine
 * sidebar rows show their `thread.jump.N` chord, numbered in sidebar order.
 */
export function ThreadsGroup({ onDone }: GroupProps) {
  const navigate = useNavigate();
  const threads = useThreadList();
  const projects = useProjects();
  const { order } = useThreadTargets();

  if (threads.length === 0) {
    return null;
  }

  const projectName = (projectId: ProjectId): string =>
    projects.find((project) => project.projectId === projectId)?.name ?? "Other threads";

  return (
    <>
      <CommandSeparator />
      <CommandGroup heading="Threads">
        {paletteThreads(threads).map((thread) => {
          const archived = thread.status === "archived";
          return (
            <CommandItem
              key={thread.threadId}
              value={`${thread.title} ${projectName(thread.projectId)} ${thread.threadId}${archived ? " archived" : ""}`}
              onSelect={() => {
                onDone();
                void navigate({ to: "/t/$threadId", params: { threadId: thread.threadId } });
              }}
            >
              {archived ? <Archive variant="bold" /> : <Chat variant="bold" />}
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              <span className="shrink-0 type-micro text-muted-foreground">
                {archived
                  ? `Archived · ${projectName(thread.projectId)}`
                  : projectName(thread.projectId)}
              </span>
              <ItemShortcut command={threadJumpCommand(order, thread.threadId)} />
            </CommandItem>
          );
        })}
      </CommandGroup>
    </>
  );
}

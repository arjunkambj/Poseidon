/**
 * The add/edit dialog for one MCP server entry. Owns the draft record and the
 * `McpServerConfig` assembly (stdio command/args/env vs http url/headers); the
 * caller hands it the connector instance and the project context so
 * `connectors.mcp.add` lands in the right instance's file.
 */

import { useAtomSet } from "@effect/atom-react";
import { Button } from "@poseidon/ui/components/button";
import { Checkbox } from "@poseidon/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@poseidon/ui/components/select";
import { Textarea } from "@poseidon/ui/components/textarea";
import type { ConnectorInstanceId, ProjectId } from "@poseidon/contracts/ids";
import type { McpServerConfig, McpServerScope } from "@poseidon/contracts/connectors";
import * as Exit from "effect/Exit";
import * as React from "react";

import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { DialogActions } from "@/components/dialog-actions";
import { DialogBody } from "@/components/dialog-body";

import { CommitInput, KeyValueInput, SettingsRow } from "@/components/Settings/schema-form";
import { MCP_SCOPE_OPTIONS, selectedOptionLabel } from "@/components/Settings/select-label";

interface Draft {
  name: string;
  scope: McpServerScope;
  transport: "stdio" | "http";
  command: string;
  /** One argument per line — space-splitting would mangle paths with spaces. */
  args: string;
  env: Record<string, string> | undefined;
  url: string;
  headers: Record<string, string> | undefined;
  enabled: boolean;
}

const draftFrom = (server: McpServerConfig | null): Draft => ({
  name: server?.name ?? "",
  scope: server?.scope ?? "user",
  transport: server?.transport ?? "stdio",
  command: server?.command ?? "",
  args: (server?.args ?? []).join("\n"),
  env: server?.env,
  url: server?.url ?? "",
  headers: server?.headers,
  enabled: server?.enabled ?? true,
});

const draftToConfig = (draft: Draft): McpServerConfig | string => {
  if (draft.name.trim() === "") {
    return "Name is required";
  }
  const base = {
    name: draft.name.trim(),
    scope: draft.scope,
    enabled: draft.enabled,
  };
  if (draft.transport === "stdio") {
    if (draft.command.trim() === "") {
      return "Command is required for a stdio server";
    }
    return {
      ...base,
      transport: "stdio",
      command: draft.command.trim(),
      ...(draft.args.trim() === ""
        ? {}
        : {
            args: draft.args
              .split("\n")
              .map((line) => line.trim())
              .filter((l) => l !== ""),
          }),
      ...(draft.env === undefined ? {} : { env: draft.env }),
    };
  }
  if (draft.url.trim() === "") {
    return "URL is required for an HTTP server";
  }
  return {
    ...base,
    transport: "http",
    url: draft.url.trim(),
    ...(draft.headers === undefined ? {} : { headers: draft.headers }),
  };
};

export function McpServerDialog({
  open,
  onClose,
  editing,
  instanceId,
  projectId,
  canUseProjectScope,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The entry being edited, or `null` for a new server. */
  readonly editing: McpServerConfig | null;
  /** The connector instance whose config the server is written to. */
  readonly instanceId: ConnectorInstanceId;
  readonly projectId: ProjectId | null;
  readonly canUseProjectScope: boolean;
}) {
  const atoms = useAppAtoms();
  const upsert = useAtomSet(atoms.mcpUpsertAtom, { mode: "promiseExit" });
  const [draft, setDraft] = React.useState<Draft>(() => draftFrom(editing));
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Re-seed the draft whenever the dialog opens on a different entry.
  React.useEffect(() => {
    if (open) {
      setDraft(draftFrom(editing));
      setError(null);
    }
  }, [open, editing]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    const config = draftToConfig(draft);
    if (typeof config === "string") {
      setError(config);
      return;
    }
    setSaving(true);
    const exit = await upsert({ instanceId, projectId, server: config });
    setSaving(false);
    if (Exit.isSuccess(exit)) {
      onClose();
      return;
    }
    setError(describeExitError(exit, "Could not save the server"));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing === null ? "Add MCP server" : `Edit ${editing.name}`}</DialogTitle>
          <DialogDescription>
            Written to the connector&apos;s own config with an ownership marker — edits by hand
            outside the marker are preserved.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col divide-y">
          <SettingsRow field={{ label: "Name", control: "text" }}>
            <CommitInput
              value={draft.name}
              placeholder="my-server"
              onCommit={(next) => set("name", next)}
            />
          </SettingsRow>
          <SettingsRow
            field={{
              label: "Scope",
              control: "select",
              description: canUseProjectScope
                ? "Global writes the connector's user config; project writes the project's own."
                : "Pick a project above to write into a project's config.",
            }}
          >
            <Select
              value={draft.scope}
              onValueChange={(next) => set("scope", next === "project" ? "project" : "user")}
            >
              <SelectTrigger className="w-full">
                {/* base-ui prints the raw value unless it is handed a
                    formatter — the items are portalled away while the popup is
                    closed, so the trigger read `user` rather than "Global". */}
                <SelectValue>
                  {(value) => selectedOptionLabel(MCP_SCOPE_OPTIONS, value) ?? "Global"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {MCP_SCOPE_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    disabled={option.value === "project" && !canUseProjectScope}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow field={{ label: "Transport", control: "select" }}>
            <Select
              value={draft.transport}
              onValueChange={(next) => set("transport", next === "http" ? "http" : "stdio")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">stdio</SelectItem>
                <SelectItem value="http">http</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>

          {draft.transport === "stdio" ? (
            <>
              <SettingsRow field={{ label: "Command", control: "text" }}>
                <CommitInput
                  value={draft.command}
                  placeholder="npx"
                  onCommit={(next) => set("command", next)}
                />
              </SettingsRow>
              <SettingsRow
                field={{ label: "Arguments", control: "text", description: "One per line." }}
              >
                <Textarea
                  value={draft.args}
                  onChange={(event) => set("args", event.target.value)}
                  rows={3}
                />
              </SettingsRow>
              <SettingsRow field={{ label: "Environment", control: "keyValue" }}>
                <KeyValueInput value={draft.env ?? {}} onChange={(next) => set("env", next)} />
              </SettingsRow>
            </>
          ) : (
            <>
              <SettingsRow field={{ label: "URL", control: "text" }}>
                <CommitInput
                  value={draft.url}
                  placeholder="https://example.com/mcp"
                  onCommit={(next) => set("url", next)}
                />
              </SettingsRow>
              <SettingsRow field={{ label: "Headers", control: "keyValue" }}>
                <KeyValueInput
                  value={draft.headers ?? {}}
                  onChange={(next) => set("headers", next)}
                />
              </SettingsRow>
            </>
          )}

          <SettingsRow field={{ label: "Enabled", control: "toggle" }}>
            <div className="flex justify-end">
              <Checkbox
                checked={draft.enabled}
                onCheckedChange={(checked) => set("enabled", checked === true)}
                aria-label="Enabled"
              />
            </div>
          </SettingsRow>
        </DialogBody>

        {error === null ? null : <p className="text-xs text-removed">{error}</p>}

        <DialogActions>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

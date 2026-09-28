/**
 * The Permissions page: every saved permission rule, grouped by how far it
 * reaches, with Edit (the pattern only) and Delete.
 *
 * Rules are saved by "Allow for session" (a rule for that thread) and "Always
 * allow" (a rule for the project) on an approval card. The server's
 * `permission_rules` table is their source of truth and `settings.permissions`
 * a projection of it, so this page reads the settings subscription and writes
 * the whole array back through `settings.update`, which replaces the table.
 * Each write is computed from the latest list at the moment of the click, by
 * rule key (`./permission-rules`): an approval answered elsewhere can land
 * while the page is open, and the list re-renders from the subscription when
 * it does.
 */

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as React from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@poseidon/ui/components/empty";
import type { PermissionRule } from "@poseidon/contracts/settings";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { describeExitError, useAppAtoms } from "@/lib/app-runtime";
import { useConnectionState, useProjects, useThreadList } from "@/state/hooks";
import { Lock } from "@honeyicons/react";

import { EditRuleDialog } from "./edit-rule-dialog";
import { PermissionRuleRow } from "./permission-rule-row";
import { groupRules, ruleKey, withoutRule, withPattern } from "./permission-rules";
import { SettingsPageHeader, SettingsSection } from "./settings-section";

const NO_RULES: ReadonlyArray<PermissionRule> = [];

const GROUP_REACH: Record<PermissionRule["scope"], string> = {
  global: "Applies in every project.",
  project: "Applies to every thread in this project.",
  session: "Applies to this thread only.",
};

const DELETE_DESCRIPTION: Record<PermissionRule["decision"], string> = {
  allow: "Poseidon asks again before running requests this rule allowed.",
  deny: "Requests this rule denied are decided again by your other rules and the thread's runtime mode.",
};

export function PermissionsPanel() {
  const atoms = useAppAtoms();
  const settingsResult = useAtomValue(atoms.settingsAtom);
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "promiseExit" });
  const projects = useProjects();
  const threads = useThreadList();
  const connection = useConnectionState();

  const [editing, setEditing] = React.useState<{
    readonly rule: PermissionRule;
    readonly groupTitle: string;
  } | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<PermissionRule | null>(null);

  const settings = AsyncResult.isSuccess(settingsResult) ? settingsResult.value : null;
  const rules = settings?.permissions ?? NO_RULES;
  const groups = React.useMemo(
    () => groupRules(rules, projects, threads),
    [rules, projects, threads],
  );

  if (settings === null) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }

  const disabled = connection.status !== "connected";

  /**
   * Writes `next` over the saved rules, unless the rule is already gone. The
   * handlers calling this are recreated on every render, so `rules` here is
   * the list the subscription last delivered, not the one a dialog opened on.
   */
  const save = async (
    target: PermissionRule,
    next: (current: ReadonlyArray<PermissionRule>) => ReadonlyArray<PermissionRule> | null,
    done: string,
  ) => {
    if (!rules.some((rule) => ruleKey(rule) === ruleKey(target))) {
      toast.error("That rule is no longer saved");
      return;
    }
    const permissions = next(rules);
    if (permissions === null) {
      return;
    }
    const exit = await updateSettings({ permissions });
    if (Exit.isSuccess(exit)) {
      toast.success(done);
    } else {
      toast.error(describeExitError(exit, "Could not save permission rules"));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="Permissions"
        description="Rules saved when you answer an approval with “Allow for session” or “Always allow”. A deny rule beats an allow rule, and a request that touches a sensitive file always asks, whatever the rules say."
      />

      {groups.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Lock variant="bold" />
            </EmptyMedia>
            <EmptyTitle>No saved rules</EmptyTitle>
            <EmptyDescription>
              Answer an approval with “Allow for session” or “Always allow” and the rule shows up
              here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        groups.map((group) => (
          <SettingsSection
            key={group.key}
            title={group.title}
            description={GROUP_REACH[group.scope]}
          >
            <ul className="flex flex-col divide-y divide-border">
              {group.rules.map((rule) => (
                <PermissionRuleRow
                  key={ruleKey(rule)}
                  rule={rule}
                  disabled={disabled}
                  onEdit={() => {
                    setEditing({ rule, groupTitle: group.title });
                    setEditOpen(true);
                  }}
                  onDelete={() => setDeleting(rule)}
                />
              ))}
            </ul>
          </SettingsSection>
        ))
      )}

      <EditRuleDialog
        rule={editing?.rule ?? null}
        groupTitle={editing?.groupTitle ?? ""}
        rules={rules}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSubmit={(rule, pattern) =>
          void save(
            rule,
            (current) => {
              const edit = withPattern(current, rule, pattern);
              if (!edit.ok) {
                if (edit.reason === "duplicate") {
                  toast.error("Another rule there already uses this pattern");
                }
                return null;
              }
              return edit.rules;
            },
            "Rule updated",
          )
        }
      />

      {/* One dialog for the page, not one per row: it describes whichever
          rule is pending deletion. There is no undo, so it asks first. */}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleting(null);
          }
        }}
        title="Delete rule?"
        description={deleting === null ? "" : DELETE_DESCRIPTION[deleting.decision]}
        confirmLabel="Delete rule"
        onConfirm={() => {
          if (deleting === null) {
            return;
          }
          const rule = deleting;
          setDeleting(null);
          void save(rule, (current) => withoutRule(current, rule), "Rule deleted");
        }}
      />
    </div>
  );
}

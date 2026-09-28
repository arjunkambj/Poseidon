/**
 * Edit a saved rule's pattern. Only the pattern: the decision and the scope
 * stay what "Allow for session" or "Always allow" (or a deny) saved them as.
 *
 * The field is the approval card's `PatternEditor`, so the syntax help and
 * the parse check read the same in both places. Save stays disabled until
 * `withPattern` accepts the edit against the list the dialog is given — a
 * pattern that does not parse, the current pattern, or one another rule in
 * the same place already has.
 */

import * as React from "react";

import { Button } from "@poseidon/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@poseidon/ui/components/dialog";
import type { PermissionRule } from "@poseidon/contracts/settings";

import { DialogActions } from "@/components/dialog-actions";
import { PatternEditor } from "@/components/approvals/pattern-editor";

import { withPattern } from "./permission-rules";

/** Where the rule applies, as the end of a sentence. */
const reach = (scope: PermissionRule["scope"], title: string): string => {
  switch (scope) {
    case "global":
      return "in every project";
    case "project":
      return `in the project ${title}`;
    case "session":
      return `in the thread ${title}`;
  }
};

export function EditRuleDialog({
  rule,
  groupTitle,
  rules,
  open,
  onOpenChange,
  onSubmit,
}: {
  readonly rule: PermissionRule | null;
  /** The title of the group the rule is listed under. */
  readonly groupTitle: string;
  /** Every saved rule, to refuse a pattern another rule already has. */
  readonly rules: ReadonlyArray<PermissionRule>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (rule: PermissionRule, pattern: string) => void;
}) {
  const [pattern, setPattern] = React.useState(rule?.pattern ?? "");
  // Seeded per opening, so a second edit starts from the rule, not the draft
  // the last one was cancelled with.
  React.useEffect(() => {
    if (open && rule !== null) {
      setPattern(rule.pattern);
    }
  }, [open, rule]);

  const edit = rule === null ? null : withPattern(rules, rule, pattern);
  const canSubmit = edit !== null && edit.ok;

  const submit = () => {
    if (rule !== null && canSubmit) {
      onOpenChange(false);
      onSubmit(rule, pattern.trim());
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit rule</DialogTitle>
          <DialogDescription>
            {rule === null
              ? null
              : `${rule.decision === "deny" ? "A deny" : "An allow"} rule ${reach(rule.scope, groupTitle)}. Only the pattern changes.`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <PatternEditor value={pattern} onChange={setPattern} autoFocus />
          {edit !== null && !edit.ok && edit.reason === "duplicate" ? (
            <p className="text-xs text-destructive">Another rule here already uses this pattern.</p>
          ) : null}
          <DialogActions>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              Save
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

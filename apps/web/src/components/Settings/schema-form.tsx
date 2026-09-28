/**
 * Renders a settings form from field descriptors — label, description and
 * control, read off each field's `settingsForm` key annotation — so a
 * connector (or any settings struct) gets a form with zero bespoke JSX. The
 * descriptors come from `settingsFormFields` over a local struct
 * (`StructForm`), or over the wire for a connector's config, whose schema
 * never leaves the server (`connectors.describe`). The value in flight is a
 * plain `Record<string, unknown>`; `onFieldChange` receives `undefined` to
 * mean "leave the key absent", which is how optional fields stay unset rather
 * than written back as empty strings.
 *
 * Controls: `text`/`path` commit on blur or Enter, `toggle`/`select` commit on
 * change, `keyValue` edits a `Record<string, string>` row-wise, `shortcut`
 * captures the next chord, `hidden` renders nothing.
 */

import { Button } from "@poseidon/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@poseidon/ui/components/tooltip";
import { Checkbox } from "@poseidon/ui/components/checkbox";
import { Input } from "@poseidon/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@poseidon/ui/components/select";
import {
  settingsFormFields,
  type SettingsFormField,
  type SettingsFormFieldDescriptor,
} from "@poseidon/contracts/settings";
import { detectModKey, formatEventAsShortcut } from "@poseidon/client-runtime/keybindings";

import { selectedOptionLabel } from "./select-label";
import { SettingsRow as SectionRow } from "./settings-section";
import { isObject, isString } from "effect/Predicate";
import type * as Schema from "effect/Schema";
import * as React from "react";

import { Close } from "@honeyicons/react";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

const stringValue = (value: unknown): string => (isString(value) ? value : "");

const recordValue = (value: unknown): Record<string, string> => {
  if (!isObject(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isString(item)) {
      out[key] = item;
    }
  }
  return out;
};

/** One settings row: the annotation's label and description left, control right. */
export function SettingsRow({
  field,
  children,
}: {
  readonly field: SettingsFormField;
  readonly children: React.ReactNode;
}) {
  return (
    <SectionRow title={field.label} description={field.description}>
      <div className="w-72">{children}</div>
    </SectionRow>
  );
}

/**
 * A text input that edits a local draft and commits on blur or Enter, so the
 * subscribed settings document cannot echo a stale value over a half-typed one.
 */
export function CommitInput({
  value,
  placeholder,
  onCommit,
}: {
  readonly value: string;
  readonly placeholder?: string;
  readonly onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  return (
    <Input
      value={draft ?? value}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) {
          onCommit(draft);
        }
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * A `keyValue` control: rows of key + value inputs. Rows live in local state so
 * a half-edited `["", ""]` row survives; the emitted record drops empty keys.
 */
export function KeyValueInput({
  value,
  onChange,
}: {
  readonly value: Record<string, string>;
  readonly onChange: (next: Record<string, string> | undefined) => void;
}) {
  const [rows, setRows] = React.useState<Array<readonly [string, string]>>(() =>
    Object.entries(value),
  );

  // Resync when the record changes underneath us (a subscribe echo or reset).
  React.useEffect(() => {
    const incoming = Object.entries(value);
    const projected = rows.filter(([key]) => key !== "");
    const same =
      projected.length === incoming.length &&
      projected.every(([key, item]) => value[key] === item && incoming.some(([k]) => k === key));
    if (!same) {
      setRows(incoming);
    }
    // `rows` is the draft; `value` is the truth — resync on value only.
  }, [value]);

  const emit = (next: Array<readonly [string, string]>) => {
    setRows(next);
    const record: Record<string, string> = {};
    for (const [key, item] of next) {
      if (key !== "") {
        record[key] = item;
      }
    }
    onChange(Object.keys(record).length === 0 ? undefined : record);
  };

  return (
    <div className="flex flex-col gap-2">
      {rows.map(([key, item], index) => (
        <div key={index} className="flex items-center gap-2">
          <CommitInput
            value={key}
            placeholder="NAME"
            onCommit={(nextKey) =>
              emit(rows.map((row, i) => (i === index ? ([nextKey, row[1]] as const) : row)))
            }
          />
          <CommitInput
            value={item}
            placeholder="value"
            onCommit={(nextValue) =>
              emit(rows.map((row, i) => (i === index ? ([row[0], nextValue] as const) : row)))
            }
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={key === "" ? "Remove row" : `Remove ${key}`}
                  onClick={() => emit(rows.filter((_, i) => i !== index))}
                />
              }
            >
              <Close variant="bold" />
            </TooltipTrigger>
            <TooltipContent>Remove variable</TooltipContent>
          </Tooltip>
        </div>
      ))}
      <div>
        <Button variant="outline" size="sm" onClick={() => setRows([...rows, ["", ""]])}>
          Add variable
        </Button>
      </div>
    </div>
  );
}

/**
 * A `shortcut` control: click, then press the chord. The stored notation is
 * `Mod+Shift+B` — `Mod` stands for the platform modifier and is normalised at
 * the point of use. Escape alone records `Escape`; it is a real binding.
 *
 * There is no "clear". A `shortcut` field is a `NonEmptyString` by contract, so
 * no consumer can accept an empty one — Backspace used to call
 * `onChange(undefined)` and the keybindings page silently dropped the write,
 * leaving a control that looked like it did something and never did. Removing a
 * binding is the row's own action, not this button's.
 */
function ShortcutInput({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
}) {
  const [listening, setListening] = React.useState(false);
  return (
    <Button
      variant={listening ? "secondary" : "outline"}
      size="sm"
      onClick={() => setListening(true)}
      onBlur={() => setListening(false)}
      onKeyDown={(event) => {
        if (!listening) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const shortcut = formatEventAsShortcut(event, detectModKey());
        if (shortcut === null) {
          // A lone modifier, or a key the notation cannot write (Super off
          // macOS) — keep listening for a chord it can.
          return;
        }
        onChange(shortcut);
        setListening(false);
      }}
    >
      {listening ? "Press keys…" : value === "" ? "Set shortcut" : value}
    </Button>
  );
}

interface FormProps {
  readonly value: Record<string, unknown>;
  readonly onFieldChange: (key: string, value: unknown) => void;
  /** Options for `select` controls — the page decides where choices come from. */
  readonly optionsFor?: (key: string, field: SettingsFormField) => ReadonlyArray<SelectOption>;
  /** Extra keys to skip even though they are not annotated `hidden`. */
  readonly skip?: ReadonlyArray<string>;
}

export interface SchemaFormProps extends FormProps {
  readonly fields: ReadonlyArray<SettingsFormFieldDescriptor>;
}

/** Every non-hidden field descriptor, in the order given, a hairline between rows. */
export function SchemaForm({ fields, value, onFieldChange, optionsFor, skip }: SchemaFormProps) {
  return (
    <div className="flex flex-col divide-y">
      {fields.map((field) => {
        const key = field.key;
        if (field.control === "hidden" || (skip !== undefined && skip.includes(key))) {
          return null;
        }
        const current = value[key];
        const change = (next: unknown) => onFieldChange(key, next);
        let control: React.ReactNode;
        switch (field.control) {
          case "toggle":
            control = (
              <Checkbox
                checked={current === true}
                onCheckedChange={(checked) => change(checked === true)}
                aria-label={field.label}
              />
            );
            break;
          case "select": {
            const options = optionsFor?.(key, field) ?? [];
            control = (
              <Select
                value={isString(current) ? current : null}
                onValueChange={(next) => change(next ?? undefined)}
              >
                <SelectTrigger className="w-full">
                  {/* base-ui renders the raw value unless it is handed a
                      formatter — the items are portalled away while the popup
                      is closed, so there is no label registry to consult. */}
                  <SelectValue placeholder="Choose…">
                    {(value) => selectedOptionLabel(options, value) ?? "Choose…"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
            break;
          }
          case "keyValue":
            control = (
              <KeyValueInput value={recordValue(current)} onChange={(next) => change(next)} />
            );
            break;
          case "shortcut":
            control = (
              <ShortcutInput value={stringValue(current)} onChange={(next) => change(next)} />
            );
            break;
          case "path":
            control = (
              <CommitInput
                value={stringValue(current)}
                placeholder={field.placeholder}
                onCommit={(next) => change(next === "" ? undefined : next)}
              />
            );
            break;
          default:
            control = (
              <CommitInput
                value={stringValue(current)}
                placeholder={field.placeholder}
                onCommit={(next) => change(next === "" ? undefined : next)}
              />
            );
        }
        return (
          <SettingsRow key={key} field={field}>
            {control}
          </SettingsRow>
        );
      })}
    </div>
  );
}

/** `SchemaForm` over a struct this bundle holds, read through its annotations. */
export function StructForm({
  schema,
  ...props
}: FormProps & { readonly schema: { readonly fields: Schema.Struct.Fields } }) {
  const fields = React.useMemo(() => settingsFormFields(schema), [schema]);
  return <SchemaForm fields={fields} {...props} />;
}

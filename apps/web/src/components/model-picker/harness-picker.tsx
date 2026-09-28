/**
 * The harness picker's popup body: a search input on top, then a column of
 * round harness avatars (the rail) with the highlighted harness's models in a
 * flyout beside it. Typing swaps the flyout for one flat list of matches
 * across every harness on the rail, each led by its harness's monogram.
 *
 * DOM focus never leaves the input. Every key goes through `pickerReduce`
 * (`@/lib/harness-picker`) and the input's `aria-activedescendant` names the
 * option the state highlights, so arrows walk the rail and the flyouts, Enter
 * picks, and Escape peels a layer: the query, the flyout, then the popup.
 *
 * Every flyout is rendered into one grid cell, the hidden ones `invisible`,
 * so the body is as tall as the longest list (up to its cap) and does not
 * jump while the pointer runs down the rail.
 */

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@poseidon/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@poseidon/ui/components/input-group";
import { cn } from "@poseidon/ui/lib/utils";
import * as React from "react";

import {
  initialPickerState,
  pickerReduce,
  searchModels,
  type HarnessRailEntry,
  type PickerEvent,
  type PickerState,
  type PickerStep,
} from "@/lib/harness-picker";
import type { ModelPick } from "@/lib/model-picks";
import { Search } from "@honeyicons/react";

import { activeOptionId, keyStep, modelOptionId, resultOptionId } from "./picker-keys";
import { HarnessRailColumn, PickerRow, SWITCH_CONNECTOR_TOOLTIP } from "./picker-rows";

function NoModels({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** One harness's flyout: its name, then its models. */
function Flyout({
  base,
  entry,
  index,
  state,
  shown,
  dispatch,
  onChoose,
}: {
  readonly base: string;
  readonly entry: HarnessRailEntry;
  readonly index: number;
  readonly state: PickerState;
  readonly shown: boolean;
  readonly dispatch: (event: PickerEvent) => void;
  readonly onChoose: (pick: ModelPick) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label={`${entry.label} models`}
      aria-hidden={!shown || undefined}
      className={cn(
        "col-start-1 row-start-1 flex min-h-0 flex-col overflow-y-auto pl-1",
        !shown && "invisible",
      )}
    >
      <div className="flex shrink-0 items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
        <span className="truncate font-medium">{entry.label}</span>
        {entry.locked ? <span className="truncate">· {SWITCH_CONNECTOR_TOOLTIP}</span> : null}
      </div>
      {entry.items.length === 0 ? (
        <NoModels
          title="No models"
          description="Every model of this harness is off in Settings → Models."
        />
      ) : (
        entry.items.map((item, model) => (
          <PickerRow
            key={item.value}
            id={modelOptionId(base, index, model)}
            item={item}
            active={shown && state.zone === "models" && state.model === model}
            onHover={() => dispatch({ type: "hoverModel", index: model })}
            onChoose={() => onChoose(item.pick)}
          />
        ))
      )}
    </div>
  );
}

export interface HarnessPickerViewProps {
  readonly base: string;
  readonly rail: ReadonlyArray<HarnessRailEntry>;
  readonly state: PickerState;
  /** The current model when no harness lists it, shown verbatim above the lists. */
  readonly unlisted?: string;
  readonly inputRef?: React.Ref<HTMLInputElement>;
  readonly dispatch: (event: PickerEvent) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  readonly onChoose: (pick: ModelPick) => void;
}

/** The body for a given state; `HarnessPicker` holds the state. */
export function HarnessPickerView({
  base,
  rail,
  state,
  unlisted,
  inputRef,
  dispatch,
  onKeyDown,
  onChoose,
}: HarnessPickerViewProps) {
  const searching = state.query.trim().length > 0;
  const results = searching ? searchModels(rail, state.query) : [];

  return (
    <div className="flex w-96 max-w-full flex-col gap-2">
      <InputGroup>
        <InputGroupAddon>
          <Search variant="bold" />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          role="combobox"
          aria-label="Search models"
          aria-expanded
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId(base, state, rail)}
          placeholder="Search models"
          autoComplete="off"
          spellCheck={false}
          value={state.query}
          onChange={(event) => dispatch({ type: "setQuery", text: event.target.value })}
          onKeyDown={onKeyDown}
        />
      </InputGroup>
      {unlisted === undefined ? null : (
        <div className="truncate px-2 text-xs text-muted-foreground">Current · {unlisted}</div>
      )}
      {rail.length === 0 ? (
        <NoModels title="No models" description="Switch a harness on in Settings → Models." />
      ) : (
        <div className="flex max-h-72 min-h-0">
          <HarnessRailColumn
            base={base}
            rail={rail}
            shown={searching ? null : state.harness}
            onHover={(index) => dispatch({ type: "hoverHarness", index })}
          />
          <div className="grid min-w-0 flex-1 grid-rows-1">
            {rail.map((entry, index) => (
              <Flyout
                key={entry.instanceId}
                base={base}
                entry={entry}
                index={index}
                state={state}
                shown={!searching && state.harness === index}
                dispatch={dispatch}
                onChoose={onChoose}
              />
            ))}
            {searching ? (
              <div
                role="listbox"
                aria-label="Matching models"
                className="col-start-1 row-start-1 flex min-h-0 flex-col overflow-y-auto pl-1"
              >
                {results.length === 0 ? (
                  <NoModels
                    title="No models match"
                    description={`Nothing on this list matches “${state.query.trim()}”.`}
                  />
                ) : (
                  results.map((result, index) => (
                    <PickerRow
                      key={result.item.value}
                      id={resultOptionId(base, index)}
                      item={result.item}
                      harness={rail[result.harnessIndex]}
                      active={state.result === index}
                      onHover={() => dispatch({ type: "hoverModel", index })}
                      onChoose={() => onChoose(result.item.pick)}
                    />
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/** The popup body with its state, opened on the current harness and model. */
export function HarnessPicker({
  rail,
  current,
  unlisted,
  inputRef,
  onPick,
  onClose,
}: {
  readonly rail: ReadonlyArray<HarnessRailEntry>;
  readonly current: ModelPick | null;
  readonly unlisted?: string;
  readonly inputRef?: React.Ref<HTMLInputElement>;
  readonly onPick: (pick: ModelPick) => void;
  readonly onClose: () => void;
}) {
  const base = React.useId();
  const [state, setState] = React.useState(() => initialPickerState(rail, current));

  const apply = (step: PickerStep) => {
    setState(step.state);
    if (step.effect?.type === "pick") {
      onPick(step.effect.pick);
    } else if (step.effect?.type === "close") {
      onClose();
    }
  };

  // The highlighted option scrolls into view as the keys move it.
  const active = activeOptionId(base, state, rail);
  React.useEffect(() => {
    if (active !== undefined) {
      document.getElementById(active)?.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  return (
    <HarnessPickerView
      base={base}
      rail={rail}
      state={state}
      {...(unlisted === undefined ? {} : { unlisted })}
      {...(inputRef === undefined ? {} : { inputRef })}
      dispatch={(event) => apply(pickerReduce(state, event, rail))}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) {
          return;
        }
        const step = keyStep(event.key, state, rail);
        if (step === null) {
          return;
        }
        if (step.handled) {
          // Escape is ours to peel layer by layer; the popup's own dismissal
          // would close it outright.
          event.preventDefault();
          event.stopPropagation();
        }
        apply(step);
      }}
      onChoose={onPick}
    />
  );
}

import { ToggleGroup, ToggleGroupItem } from "@poseidon/ui/components/toggle-group";
import type { ChatWidth } from "@poseidon/contracts/settings";

import { CHAT_WIDTHS } from "@/lib/chat-width";
import { useChatWidth } from "@/lib/use-chat-width";

/**
 * The toggle itself, given the width and what to do with a new one. Pressing
 * the item that is already on would leave nothing pressed; that deselect is
 * ignored, so one width is always picked.
 */
export function ChatWidthPicker({
  width,
  onChange,
}: {
  readonly width: ChatWidth;
  readonly onChange: (next: ChatWidth) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm">Chat width</div>
        <div className="text-sm text-muted-foreground">
          How wide the thread and the composer grow.
        </div>
      </div>
      <ToggleGroup
        aria-label="Chat width"
        variant="outline"
        size="sm"
        spacing={0}
        className="shrink-0"
        value={[width]}
        onValueChange={(value) => {
          const next = CHAT_WIDTHS.find((entry) => entry.value === value[0]);
          if (next !== undefined) {
            onChange(next.value);
          }
        }}
      >
        {CHAT_WIDTHS.map((entry) => (
          <ToggleGroupItem key={entry.value} value={entry.value}>
            {entry.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * The chat width row on the General page. The `chatWidth.cycle` command steps
 * the same setting through `useChatWidth`, so the toggle follows it at once.
 */
export function ChatWidthToggle() {
  const { width, setWidth } = useChatWidth();
  return (
    <div className="max-w-3xl">
      <h2 className="mb-2 text-sm font-medium">Layout</h2>
      <ChatWidthPicker width={width} onChange={setWidth} />
    </div>
  );
}

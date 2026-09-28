import { ToggleGroup, ToggleGroupItem } from "@poseidon/ui/components/toggle-group";
import type { ChatWidth } from "@poseidon/contracts/settings";

import { CHAT_WIDTHS } from "@/lib/chat-width";
import { useChatWidth } from "@/lib/use-chat-width";

import { SettingsRow, SettingsSection } from "./settings-section";

/**
 * The chat width row, given the width and what to do with a new one. Pressing
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
    <SettingsRow title="Chat width" description="How wide the thread and the composer grow.">
      <ToggleGroup
        aria-label="Chat width"
        variant="outline"
        size="sm"
        spacing={0}
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
    </SettingsRow>
  );
}

/**
 * The Layout section on the General page. The `chatWidth.cycle` command steps
 * the same setting through `useChatWidth`, so the toggle follows it at once.
 */
export function ChatWidthToggle() {
  const { width, setWidth } = useChatWidth();
  return (
    <SettingsSection title="Layout">
      <ChatWidthPicker width={width} onChange={setWidth} />
    </SettingsSection>
  );
}

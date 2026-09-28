import { useAtomSet } from "@effect/atom-react";
import { useEffect, useState } from "react";

import { cn } from "@poseidon/ui/lib/utils";

import { useTheme } from "@/components/theme-provider";
import { useAppAtoms } from "@/lib/app-runtime";

const themes = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

type ThemeValue = (typeof themes)[number]["value"];

function ThemeWindow({ scheme }: { scheme: "light" | "dark" }) {
  const isDark = scheme === "dark";

  return (
    <div
      className={cn(
        "relative h-full overflow-hidden rounded-lg",
        isDark ? "bg-preview-chrome-dark" : "bg-preview-chrome-light",
      )}
    >
      <div className="flex flex-col gap-1.5 px-5 pt-4">
        <div
          className={cn(
            "h-1.5 w-16 rounded-full",
            isDark ? "bg-preview-bar-dark" : "bg-preview-bar-light",
          )}
        />
        <div
          className={cn(
            "h-1 w-28 rounded-full",
            isDark ? "bg-preview-bar-dark/70" : "bg-preview-bar-light/70",
          )}
        />
      </div>
      <div
        className={cn(
          "absolute inset-x-4 top-12 bottom-0 rounded-t-lg",
          isDark ? "bg-preview-surface" : "bg-white",
        )}
      >
        <div className="flex flex-col gap-2.5 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-10 rounded-full bg-preview-line-strong" />
            <div className="h-1 flex-1 rounded-full bg-preview-line" />
          </div>
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-10 rounded-full bg-preview-line-strong" />
            <div className="h-1 flex-1 rounded-full bg-preview-line" />
          </div>
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-10 rounded-full bg-preview-line-strong" />
            <div className="h-1 w-1/2 rounded-full bg-preview-line" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ThemePreview({ value }: { value: ThemeValue }) {
  if (value === "system") {
    return (
      <div className="relative h-full">
        <ThemeWindow scheme="light" />
        <div className="absolute inset-0 bg-black/50 [clip-path:inset(0_0_0_50%)]" />
      </div>
    );
  }

  return <ThemeWindow scheme={value} />;
}

export function ThemeCards() {
  const { theme, setTheme } = useTheme();
  const atoms = useAppAtoms();
  const updateSettings = useAtomSet(atoms.settingsUpdateAtom, { mode: "value" });
  const [mounted, setMounted] = useState(false);

  const pick = (value: ThemeValue) => {
    setTheme(value);
    updateSettings({ theme: value });
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  const selected = mounted ? theme : undefined;

  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-4">
      {themes.map((item) => {
        const isSelected = selected === item.value;

        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => pick(item.value)}
            className="flex flex-col items-center gap-2 rounded-xl outline-none"
          >
            <div
              className={cn(
                // padding-ok: the preview's even frame
                "aspect-[16/10] w-full rounded-xl p-0.5",
                isSelected && "ring-2 ring-foreground",
              )}
            >
              <div className="h-full overflow-hidden rounded-nested">
                <ThemePreview value={item.value} />
              </div>
            </div>
            <span
              className={cn("text-sm", isSelected ? "text-foreground" : "text-muted-foreground")}
            >
              {item.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

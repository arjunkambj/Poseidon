import { createFileRoute } from "@tanstack/react-router";

import { SessionImportPanel } from "@/components/import/session-import-panel";
import { SettingsPageHeader } from "@/components/Settings/settings-section";

export const Route = createFileRoute("/settings/import")({
  component: ImportPage,
});

function ImportPage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <SettingsPageHeader
          title="Import"
          description="Bring sessions your harnesses recorded outside Poseidon in as threads. Their session files are only read, never changed."
        />
        <SessionImportPanel />
      </div>
    </div>
  );
}

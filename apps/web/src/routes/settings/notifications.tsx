import { createFileRoute } from "@tanstack/react-router";

import { NotificationsPanel } from "@/components/Settings/notifications-panel";

export const Route = createFileRoute("/settings/notifications")({
  component: NotificationsPage,
});

function NotificationsPage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-8 py-10">
      <div className="w-full max-w-3xl">
        <NotificationsPanel />
      </div>
    </div>
  );
}

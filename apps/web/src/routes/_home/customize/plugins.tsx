import { createFileRoute } from "@tanstack/react-router";

import { PluginsTab } from "@/components/customize/plugins-tab";

export const Route = createFileRoute("/_home/customize/plugins")({
  component: PluginsTab,
});

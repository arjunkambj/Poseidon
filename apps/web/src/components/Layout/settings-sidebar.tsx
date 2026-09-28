import { Link, useMatchRoute } from "@tanstack/react-router";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@poseidon/ui/components/sidebar";

import { SettingsWindowChrome } from "@/components/Layout/window-chrome";
import { SidebarPrimaryNav } from "@/components/sidebar/sidebar-primary-nav";
import {
  Archive,
  Bell,
  Brain,
  Connect,
  GitBranch,
  Globe,
  Import,
  Keyboard,
  Lock,
  SlidersHorizontal,
} from "@honeyicons/react";

const ITEMS = [
  { to: "/settings", label: "General", icon: SlidersHorizontal },
  { to: "/settings/models", label: "Models", icon: Brain },
  { to: "/settings/connectors", label: "Connectors", icon: Connect },
  { to: "/settings/keybindings", label: "Keybindings", icon: Keyboard },
  { to: "/settings/permissions", label: "Permissions", icon: Lock },
  { to: "/settings/git", label: "Git & worktrees", icon: GitBranch },
  { to: "/settings/browser", label: "Browser", icon: Globe },
  { to: "/settings/notifications", label: "Notifications", icon: Bell },
  { to: "/settings/archived", label: "Archived threads", icon: Archive },
  { to: "/settings/import", label: "Import", icon: Import },
] as const;

/** The settings pages, for the command palette's deep links. */
export { ITEMS as SETTINGS_PAGES };

export function SettingsSidebar() {
  const matchRoute = useMatchRoute();

  return (
    <Sidebar collapsible="none" variant="bordered" className="h-svh">
      <SidebarHeader padding="none">
        <SettingsWindowChrome />
        <SidebarPrimaryNav />
      </SidebarHeader>
      <SidebarContent gap="none">
        <SidebarGroup padding="section">
          <SidebarGroupLabel>Settings</SidebarGroupLabel>
          <SidebarGroupContent className="mt-1">
            <SidebarMenu>
              {ITEMS.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    render={<Link to={item.to} />}
                    isActive={Boolean(matchRoute({ to: item.to, fuzzy: false }))}
                  >
                    <item.icon variant="bold" />
                    {item.label}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

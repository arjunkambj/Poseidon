/**
 * The main window's shell: sidebar, window chrome, connection banner, route
 * outlet.
 *
 * It claims exactly one keybinding, `sidebar.toggle`, because that is the one
 * whose target — this sidebar — exists only here. The route-independent
 * commands are claimed by `SearchProvider` at the app root, so they work on
 * `/settings/*` too; thread-scoped bindings
 * (`thread.interrupt`, `composer.queue`, `browserPane.toggle`) belong to the
 * thread view, which is the only component that knows which thread they act
 * on. None of them listens for keys itself — the one listener lives in
 * `KeybindingsProvider` above the routes.
 */

import { Outlet } from "@tanstack/react-router";
import type * as React from "react";

import { SidebarInset, SidebarProvider } from "@poseidon/ui/components/sidebar";
import { TooltipProvider } from "@poseidon/ui/components/tooltip";

import { ConnectionBanner } from "@/components/Layout/connection-banner";
import { InsetWindowChrome } from "@/components/Layout/window-chrome";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { SidebarToggleShortcut } from "@/lib/shortcuts";
import { useSidebarWidth } from "@/state/ui";

export function HomeLayout() {
  const [sidebarWidth] = useSidebarWidth();
  return (
    <SidebarProvider
      className="h-svh overflow-hidden"
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <TooltipProvider delay={300}>
        <SidebarToggleShortcut />
        <AppSidebar />
        <SidebarInset className="min-h-0 overflow-hidden">
          <InsetWindowChrome />
          <ConnectionBanner />
          <Outlet />
        </SidebarInset>
      </TooltipProvider>
    </SidebarProvider>
  );
}

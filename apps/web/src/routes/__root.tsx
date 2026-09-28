import { useAtomValue } from "@effect/atom-react";
import { Button } from "@poseidon/ui/components/button";
import { Toaster } from "@poseidon/ui/components/sonner";
import { HeadContent, Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { AsyncResult } from "effect/unstable/reactivity";
import * as React from "react";

import { AttentionCoordinator } from "@/components/attention/attention-coordinator";
import { QuitGuardDialog } from "@/components/attention/quit-guard-dialog";
import { BrowserHost } from "@/components/browser-host/browser-host";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { AppShortcuts } from "@/components/Layout/app-shortcuts";
import { SearchProvider } from "@/components/Layout/search-command";
import { ShortcutsDialog } from "@/components/keybindings/shortcuts-dialog";
import { WorktreeForceRemovalHost } from "@/components/sidebar/delete-thread-dialog";
import { DiffWorkerPoolProvider } from "@/components/timeline/diff-pool";
import { useAppAtoms } from "@/lib/app-runtime";
import { ClientRuntimeBridge } from "@/lib/client-runtime";
import { applyFontSizes } from "@/lib/font-size";
import { KeybindingsProvider } from "@/lib/shortcuts";
import { AppAtomRegistryProvider, getAppAtoms } from "@/state/app-runtime";
import { Unlink } from "@honeyicons/react";

import "../index.css";

export interface RouterAppContext {}

/**
 * The shell's own 404. `/_home/t/$threadId` throws `notFound()` for a param
 * that is not a UUIDv7, and without this the user got the router's bare
 * default — a dead end with no way back into the app.
 */
function NotFound() {
  return (
    <div className="flex h-svh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
      <Unlink variant="bold" className="size-6 text-muted-foreground" />
      <p className="type-body text-muted-foreground">
        That page does not exist — the link may point at a thread that was deleted.
      </p>
      <Button type="button" variant="outline" render={<Link to="/" />}>
        Back to Poseidon
      </Button>
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  notFoundComponent: NotFound,
  head: () => ({
    meta: [
      {
        title: "Poseidon",
      },
      {
        name: "description",
        content: "Poseidon — a desktop workspace for running coding agents on your projects.",
      },
    ],
    // No `links`: index.html already declares /favicon.png and the touch icon.
    // The scaffold pointed at a /favicon.ico that does not exist, which 404'd
    // on every navigation.
  }),
});

/**
 * Pushes the persisted `settings.theme` into next-themes, and the font sizes
 * onto the document, whenever the doc changes.
 */
function SettingsThemeSync() {
  const atoms = useAppAtoms();
  const result = useAtomValue(atoms.settingsAtom);
  const { setTheme } = useTheme();
  React.useEffect(() => {
    if (AsyncResult.isSuccess(result) && result.value !== null) {
      setTheme(result.value.theme);
      applyFontSizes({
        main: result.value.mainFontSize,
        sidebar: result.value.sidebarFontSize,
      });
    }
  }, [result, setTheme]);
  return null;
}

/**
 * Swallows a drop that lands on nothing. An uncancelled `drop` is a
 * navigation, and in the desktop shell that replaces the whole app with the
 * dropped file — so the guard has to be above the routes rather than inside
 * the composer, which is not mounted on /settings or /skills.
 *
 * Anything with its own drop target cancels the event first (the composer's
 * `dropHandlers` do), so this only eats what nothing wanted.
 */
function DropNavigationGuard() {
  React.useEffect(() => {
    const swallow = (event: DragEvent) => {
      if (!event.defaultPrevented) {
        event.preventDefault();
      }
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);
  return null;
}

function RootComponent() {
  return (
    <>
      <HeadContent />
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        disableTransitionOnChange
        storageKey="vite-ui-theme"
      >
        <AppAtomRegistryProvider>
          <ClientRuntimeBridge runtime={getAppAtoms()}>
            <SettingsThemeSync />
            <DropNavigationGuard />
            {/* The only keydown listener in the renderer — see @/lib/shortcuts. */}
            <KeybindingsProvider>
              {/* Thread switching and history keys, on every route. */}
              <AppShortcuts />
              {/* Notifications, toasts, the Dock badge, keep-awake and the quit guard. */}
              <AttentionCoordinator />
              <QuitGuardDialog />
              {/* The keyboard shortcuts sheet (Mod+/), on every route. */}
              <ShortcutsDialog />
              {/*
                Above the routes on purpose: the palette and the commands it
                owns — open palette, new task, Settings, Skills — are
                route-independent, and claiming them inside the home layout is
                what used to leave Cmd+K and Cmd+, dead on /settings.
              */}
              <SearchProvider>
                <DiffWorkerPoolProvider>
                  <Outlet />
                  {/*
                    Above the routes too: the thread's browser tabs must
                    outlive the dock, a thread switch and /settings, which
                    renders a layout of its own.
                  */}
                  <BrowserHost />
                  <Toaster richColors />
                  {/* Beside the toasts whose "Remove anyway" opens it. */}
                  <WorktreeForceRemovalHost />
                </DiffWorkerPoolProvider>
              </SearchProvider>
            </KeybindingsProvider>
          </ClientRuntimeBridge>
        </AppAtomRegistryProvider>
      </ThemeProvider>
      {/* Dev only — the packaged app was shipping the floating devtools button. */}
      {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-right" /> : null}
    </>
  );
}

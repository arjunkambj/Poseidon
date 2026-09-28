/**
 * The dev servers each script terminal has printed (`./dev-server-urls`),
 * kept by terminal id — presentation state, in memory only.
 *
 * The terminal's attachment notes them as its output streams in
 * (`noteDevServerUrls`); the drawer's toolbar and the Run menu read them to
 * offer "Open in browser". Only the tab in front has an attachment, which is
 * enough: a script's tab is in front when it starts, and bringing a tab back
 * rescans its scrollback. A closed or gone terminal is forgotten.
 *
 * `keepAlive`: the attachment writes and the Run menu reads, and neither may
 * be on screen when the other is.
 */

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { TerminalId } from "@poseidon/contracts/ids";
import type { AtomRegistry } from "effect/unstable/reactivity";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as React from "react";

import { DEV_SERVER_URLS_MAX } from "@/components/terminal/dev-server-urls";

type DevServers = Readonly<Record<string, ReadonlyArray<string>>>;

const devServersAtom = Atom.keepAlive(Atom.make<DevServers>({}));

const none: ReadonlyArray<string> = [];

/** Adds `urls` to the terminal's, first seen first, at most `DEV_SERVER_URLS_MAX`. */
const noteDevServerUrls = (
  registry: AtomRegistry.AtomRegistry,
  terminalId: TerminalId,
  urls: ReadonlyArray<string>,
): void => {
  registry.update(devServersAtom, (all) => {
    const known = all[terminalId] ?? none;
    const fresh = urls.filter((url, index) => !known.includes(url) && urls.indexOf(url) === index);
    if (fresh.length === 0 || known.length >= DEV_SERVER_URLS_MAX) return all;
    return { ...all, [terminalId]: [...known, ...fresh].slice(0, DEV_SERVER_URLS_MAX) };
  });
};

/** Drops what the terminal printed, once it is closed or gone. */
const forgetDevServer = (registry: AtomRegistry.AtomRegistry, terminalId: TerminalId) => {
  registry.update(devServersAtom, (all) => {
    if (all[terminalId] === undefined) return all;
    const { [terminalId]: _forgotten, ...rest } = all;
    return rest;
  });
};

/** The dev servers one terminal printed; empty for none, or for no terminal. */
export const useDevServerUrls = (terminalId: TerminalId | null): ReadonlyArray<string> =>
  useAtomValue(
    devServersAtom,
    React.useCallback(
      (all: DevServers) => (terminalId === null ? none : (all[terminalId] ?? none)),
      [terminalId],
    ),
  );

/** Every terminal's dev servers, for the Run menu's running scripts. */
export const useAllDevServerUrls = (): DevServers => useAtomValue(devServersAtom);

/** `noteDevServerUrls` for one terminal, stable while the terminal is. */
export const useNoteDevServerUrls = (terminalId: TerminalId) => {
  const registry = React.useContext(RegistryContext);
  return React.useCallback(
    (urls: ReadonlyArray<string>) => noteDevServerUrls(registry, terminalId, urls),
    [registry, terminalId],
  );
};

/** `forgetDevServer` in this registry. */
export const useForgetDevServer = () => {
  const registry = React.useContext(RegistryContext);
  return React.useCallback(
    (terminalId: TerminalId) => forgetDevServer(registry, terminalId),
    [registry],
  );
};

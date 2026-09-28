#!/usr/bin/env node
/**
 * Package boundary check.
 *
 * Six guardrails in one pass over the tree. The rules themselves are pure
 * functions in `boundary-rules.mjs`, tested by `boundary-rules.test.mjs`; this
 * file walks the tree, feeds them and reports.
 *
 *  1. Import boundaries. Every import that names another workspace package is
 *     checked against the allowlist — the scoped `@poseidon/*` packages and the
 *     three unscoped apps (`web`, `desktop`, `server`) alike. A package may
 *     always import itself; anything else has to be listed. A package with no
 *     rule may not import any workspace package. A relative specifier that
 *     climbs out of its own workspace directory is a violation whatever it
 *     lands on: packages are consumed through their `exports` map, so
 *     `../../../packages/testkit/src/receipts` is a boundary crossing wearing a
 *     path.
 *  2. Connector leaks. The renderer, the client runtime and the server name no
 *     concrete connector: outside tests and the server's composition root
 *     (`apps/server/src/boot.ts`) they import no connector package but the SDK
 *     and write no quoted connector kind.
 *  3. The renderer connector-neutrality grep. Connector identity never reaches
 *     `apps/web/src`, outside the icon set: not a harness name, not the quoted
 *     literal `"cmd"`. Every file counts, not only the source ones — a
 *     connector name reads the same in a CSS class, an SVG title, a JSON label
 *     or a file name.
 *  4. Reference-product names. The products this one was compared against
 *     are never named in `apps/`, `packages/`, `scripts/` or the top-level
 *     `docs/*.md`, in file names or contents, recorded fixtures included.
 *  5. No barrel files. A package exports one entry per module through its
 *     `exports` map, so an `index.ts` anywhere under a
 *     `packages/` workspace is refused. Apps are not covered: the router's
 *     `routes/settings/index.tsx` is a route, not a barrel, and the Electron
 *     entry points are named by electron-builder.
 *  6. Bold icons. Every `.tsx` file under `apps/` or `packages/` renders the
 *     components it imports from `@honeyicons/react` with `variant="bold"`:
 *     the package defaults to linear and has no provider to change that, so
 *     the app-wide choice is spelled on each element. Brand colour logos (an
 *     imported export ending in `Color`) are exempt: they draw the same in
 *     both variants with the brand's own fills. Monochrome brand logos are
 *     not, because some (meta, instagram) are outlines in linear and the
 *     official mark is bold.
 *
 * Every violation is printed as `file:line` and the process exits 1.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  allowedImportsFor,
  boldIconLeaks,
  connectorLeaks,
  equalPaddingLeaks,
  importSpecifiers,
  lineOf,
  referenceNameApplies,
  referenceNameLeaks,
  rendererLeaks,
} from "./boundary-rules.mjs";

const ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/** Files the greps read by name only; their bytes are not text. */
const OPAQUE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".icns",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".mp4",
  ".webm",
  ".pdf",
  ".zip",
]);

/** Barrels are refused here; apps keep their route and entry-point index files. */
const BARREL_NAMES = new Set(["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs"]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "dist-ssr",
  "artifacts",
  ".turbo",
  ".git",
  ".vite",
  "coverage",
]);

const listDirectories = (parent) => {
  const full = NodePath.join(ROOT, parent);
  if (!NodeFS.existsSync(full)) {
    return [];
  }
  return NodeFS.readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
    .map((entry) => `${parent}/${entry.name}`)
    .sort();
};

const walkSourceFiles = (relativeDirectory) => {
  const files = [];
  const visit = (relative) => {
    const full = NodePath.join(ROOT, relative);
    if (!NodeFS.existsSync(full)) {
      return;
    }
    for (const entry of NodeFS.readdirSync(full, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          visit(child);
        }
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(NodePath.extname(entry.name))) {
        files.push(child);
      }
    }
  };
  visit(relativeDirectory);
  return files.sort();
};

/** Every file under a directory, whatever its extension. */
const walkAllFiles = (relativeDirectory) => {
  const files = [];
  const visit = (relative) => {
    const full = NodePath.join(ROOT, relative);
    if (!NodeFS.existsSync(full)) {
      return;
    }
    for (const entry of NodeFS.readdirSync(full, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          visit(child);
        }
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  visit(relativeDirectory);
  return files.sort();
};

const WORKSPACE_DIRECTORIES = [...listDirectories("apps"), ...listDirectories("packages")].filter(
  (directory) => NodeFS.existsSync(NodePath.join(ROOT, directory, "package.json")),
);

/**
 * Published package name -> workspace directory, for every workspace.
 *
 * Apps are unscoped, so `web`, `desktop` and `server` are import targets
 * that no `@poseidon/` prefix would ever reveal.
 */
const WORKSPACE_BY_PACKAGE_NAME = new Map(
  WORKSPACE_DIRECTORIES.map((directory) => [
    JSON.parse(NodeFS.readFileSync(NodePath.join(ROOT, directory, "package.json"), "utf8")).name,
    directory,
  ]),
);

/** The short name a boundary rule uses for a workspace: the directory's basename. */
const shortNameOf = (workspaceDirectory) => NodePath.basename(workspaceDirectory);

/**
 * What a specifier resolves to, seen from `file` inside `workspaceDirectory`.
 *
 * `{ kind: "workspace" }` names another workspace package, however it was
 * spelled. `{ kind: "escape" }` is a relative path that leaves the workspace
 * directory. Anything else — a node_modules package, a path inside the same
 * workspace — is not a boundary question and comes back `null`.
 */
const classifySpecifier = (specifier, file, workspaceDirectory) => {
  if (specifier.startsWith(".")) {
    const resolved = NodePath.posix.normalize(
      NodePath.posix.join(NodePath.posix.dirname(file), specifier),
    );
    if (resolved === workspaceDirectory || resolved.startsWith(`${workspaceDirectory}/`)) {
      return null;
    }
    const landing = WORKSPACE_DIRECTORIES.find(
      (directory) => resolved === directory || resolved.startsWith(`${directory}/`),
    );
    return { kind: "escape", resolved, landing: landing ?? null };
  }
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  const directory = WORKSPACE_BY_PACKAGE_NAME.get(packageName);
  return directory === undefined
    ? null
    : { kind: "workspace", packageName, target: shortNameOf(directory) };
};

const violations = [];

const report = (file, line, message) => {
  violations.push(`${file}:${line}  ${message}`);
};

/** A file's text, or `null` when its bytes are not text. */
const readText = (file) =>
  OPAQUE_EXTENSIONS.has(NodePath.extname(file))
    ? null
    : NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8");

const reportAll = (file, leaks) => {
  for (const { line, message } of leaks) {
    report(file, line, message);
  }
};

// ---------------------------------------------------------------- boundaries

for (const workspaceDirectory of WORKSPACE_DIRECTORIES) {
  const ownName = shortNameOf(workspaceDirectory);

  for (const file of walkSourceFiles(workspaceDirectory)) {
    const allowedHere = allowedImportsFor(file, workspaceDirectory);
    const source = NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8");
    for (const { specifier, index } of importSpecifiers(source)) {
      const resolution = classifySpecifier(specifier, file, workspaceDirectory);
      if (resolution === null) {
        continue;
      }
      const line = lineOf(source, index);
      if (resolution.kind === "escape") {
        report(
          file,
          line,
          resolution.landing === null
            ? `${specifier} climbs out of ${workspaceDirectory}; a package only imports its own files by path`
            : `${specifier} reaches into ${resolution.landing} by path; import ${shortNameOf(
                resolution.landing,
              )} by its package name so the boundary rule applies`,
        );
      } else if (resolution.target !== ownName) {
        if (allowedHere === undefined) {
          report(
            file,
            line,
            `${workspaceDirectory} has no boundary rule; add one to scripts/boundary-rules.mjs before importing ${specifier}`,
          );
        } else if (!allowedHere.includes(resolution.target)) {
          report(
            file,
            line,
            `${file} may not import ${resolution.packageName} (allowed: ${
              allowedHere.length === 0 ? "none" : allowedHere.join(", ")
            })`,
          );
        }
      }
    }
  }
}

// ----------------------------------------------------------- connector leaks

for (const root of ["apps/web", "packages/client-runtime", "apps/server"]) {
  for (const file of walkSourceFiles(root)) {
    reportAll(file, connectorLeaks(file, readText(file)));
  }
}

// ----------------------------------------------------- renderer neutrality

for (const file of walkAllFiles("apps/web/src")) {
  reportAll(file, rendererLeaks(file, readText(file)));
}

// --------------------------------------------------------- reference names

const topLevelDocs = NodeFS.existsSync(NodePath.join(ROOT, "docs"))
  ? NodeFS.readdirSync(NodePath.join(ROOT, "docs"), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `docs/${entry.name}`)
  : [];

for (const file of [
  ...walkAllFiles("apps"),
  ...walkAllFiles("packages"),
  ...walkAllFiles("scripts"),
  ...topLevelDocs,
]) {
  if (referenceNameApplies(file)) {
    reportAll(file, referenceNameLeaks(file, readText(file)));
  }
}

// --------------------------------------------------------------- no barrels

for (const workspaceDirectory of WORKSPACE_DIRECTORIES) {
  if (!workspaceDirectory.startsWith("packages/")) {
    continue;
  }
  for (const file of walkSourceFiles(workspaceDirectory)) {
    if (BARREL_NAMES.has(NodePath.basename(file))) {
      report(
        file,
        1,
        `barrel file: ${workspaceDirectory} exports one entry per module through package.json "exports"`,
      );
    }
  }
}

// --------------------------------------------------------------- bold icons

for (const file of [...walkSourceFiles("apps"), ...walkSourceFiles("packages")]) {
  if (NodePath.extname(file) === ".tsx") {
    reportAll(file, boldIconLeaks(file, readText(file)));
  }
}

// --------------------------------------------------------- padding asymmetry

for (const file of [...walkSourceFiles("apps"), ...walkSourceFiles("packages")]) {
  reportAll(file, equalPaddingLeaks(file, readText(file)));
}

// ------------------------------------------------------------------ verdict

if (violations.length > 0) {
  console.error(`check-boundaries: ${violations.length} violation(s)\n`);
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  console.error("");
  process.exit(1);
}

console.log("check-boundaries: ok");

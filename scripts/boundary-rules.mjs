/**
 * The rules `check-boundaries.mjs` applies, as pure functions of a path and
 * its text.
 *
 * The walker in `check-boundaries.mjs` reads the tree and reports; everything
 * that decides whether a file is in violation lives here so that
 * `boundary-rules.test.mjs` can exercise each rule on a handful of strings
 * rather than on a doctored checkout. Every matcher returns a list of
 * `{ line, message }`, empty when the file is fine.
 */

// ------------------------------------------------------------ import allowlist

/**
 * Workspace package short names each workspace directory may import.
 *
 * The renderer's rule is contracts, client-runtime and shared, plus `ui`:
 * the design system predates this app and apps/web renders through it. This
 * list is the enforced rule (docs/architecture.md, "Boundaries").
 *
 * `apps/server` does not get a connector package here: only its composition
 * root does (`FILE_ALLOWLIST`), and its tests (`TEST_ONLY_ALLOWLIST`).
 */
export const IMPORT_ALLOWLIST = new Map([
  ["apps/web", ["ui", "contracts", "client-runtime", "shared"]],
  ["apps/desktop", ["contracts", "shared"]],
  ["apps/server", ["contracts", "connector-sdk", "shared"]],
  // W11: the public site is static — it may share the design system and the
  // tiny utils but never contracts, the client runtime or server code.
  ["apps/site", ["ui", "shared"]],
  ["packages/connector-sdk", ["contracts", "shared"]],
  ["packages/connector-*", ["connector-sdk", "contracts", "shared"]],
  ["packages/contracts", ["shared"]],
  ["packages/client-runtime", ["contracts", "shared"]],
  ["packages/testkit", ["contracts", "connector-sdk", "shared"]],
  ["packages/shared", []],
  ["packages/ui", []],
  ["packages/config", []],
]);

/**
 * What a workspace's *test* files may import on top of its own allowlist.
 *
 * `@poseidon/testkit` is the fakes and the receipt helpers; the server drives
 * them from its tests and must never ship them, because apps/server is bundled
 * to `out/main.cjs` for packaging. `@poseidon/client-runtime` joins in
 * tests for the transport suite, which exercises the real client against the
 * real server over a WebSocket. `@poseidon/connector-cmd`,
 * `@poseidon/connector-claude` and `@poseidon/connector-codex` are here because a conformance or end-to-end
 * test assembles a real connector the same way the composition root does.
 * Keeping them all out of the production list is what makes an accidental
 * import in `src/main.ts` fail the gate.
 *
 * The Claude Code connector's own tests replay its recordings through
 * testkit's `sdk-stream` replayer and record them through its tee, so they
 * get testkit too; the connector's sources never do.
 *
 * `apps/desktop` tests get `testkit` for the same reason: the browser
 * bridge's tests replay the agent-browser recordings through
 * `@poseidon/testkit/recording` rather than resolving fixture paths by hand,
 * and the shell's entry points are bundled, so the rule keeps it out of them.
 */
export const TEST_ONLY_ALLOWLIST = new Map([
  [
    "apps/server",
    ["testkit", "client-runtime", "connector-cmd", "connector-claude", "connector-codex"],
  ],
  ["packages/connector-claude", ["testkit"]],
  ["packages/connector-codex", ["testkit"]],
  ["apps/desktop", ["testkit"]],
]);

/**
 * Single files that may import more than their workspace.
 *
 * The server's composition root is the one place that names the concrete
 * connectors: it builds the registry from each connector's definition, and
 * everything else in `apps/server` reaches connectors through the registry.
 */
export const FILE_ALLOWLIST = new Map([
  ["apps/server/src/boot.ts", ["connector-cmd", "connector-claude", "connector-codex"]],
]);

/**
 * A `*.test.ts` file, or anything under a workspace's `test/` directory.
 *
 * The second half is for suites too big to live in one file: the end-to-end
 * scenarios under `apps/server/test/e2e/` share a harness that dials the
 * server with the real client runtime, and a harness is not a `.test.ts`. The
 * directory is the statement of intent — nothing under it is bundled, because
 * `apps/server`'s esbuild entry is `src/main.ts` — so it carries the same
 * allowance the test files themselves do.
 */
export const isTestFile = (file) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || file.split("/").includes("test");

const workspaceAllowlist = (workspaceDirectory) => {
  const exact = IMPORT_ALLOWLIST.get(workspaceDirectory);
  if (exact !== undefined) {
    return exact;
  }
  for (const [key, allowed] of IMPORT_ALLOWLIST) {
    if (key.endsWith("*") && workspaceDirectory.startsWith(key.slice(0, -1))) {
      return allowed;
    }
  }
  return undefined;
};

/**
 * The workspace short names `file` may import, or `undefined` when its
 * workspace has no rule at all.
 */
export const allowedImportsFor = (file, workspaceDirectory) => {
  const allowed = workspaceAllowlist(workspaceDirectory);
  if (allowed === undefined) {
    return undefined;
  }
  const testExtras = isTestFile(file) ? (TEST_ONLY_ALLOWLIST.get(workspaceDirectory) ?? []) : [];
  return [...allowed, ...testExtras, ...(FILE_ALLOWLIST.get(file) ?? [])];
};

/**
 * Matches `from "x"`, bare `import "x"`, `import("x")` and `require("x")`.
 *
 * Backticks count: `import(\`@poseidon/${name}/ids\`)` is still a boundary
 * crossing, and a template literal whose package segment is static is exactly
 * how one would be written to slip past a quote-only pattern.
 */
export const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(?:["']([^"']+)["']|`([^`]+)`)/g;

/** Every import specifier in `source`, with the offset it starts at. */
export const importSpecifiers = (source) =>
  [...source.matchAll(IMPORT_PATTERN)].map((match) => ({
    specifier: match[1] ?? match[2],
    index: match.index,
  }));

export const lineOf = (source, index) => source.slice(0, index).split("\n").length;

// ------------------------------------------------------------- connector leaks

/**
 * Where no concrete connector may be named: the renderer, the client runtime
 * and the server. They reach a connector through the registry and the
 * contracts, so a harness is added without touching them.
 */
const CONNECTOR_NEUTRAL_ROOTS = ["apps/web/", "packages/client-runtime/", "apps/server/"];

/** The one server file that assembles concrete connectors. */
const COMPOSITION_ROOT = "apps/server/src/boot.ts";

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

/** A workspace connector package other than the SDK every connector builds on. */
const CONNECTOR_PACKAGE = /^@poseidon\/connector-(?!sdk(?:\/|$))[^/]+/;

/**
 * A quoted connector kind. `ConnectorKind` values travel as data (the
 * registry, `connectors.describe`); code that compares against one by name is
 * branching on a specific harness.
 */
const KIND_LITERAL = /["'`](cmd|claude|codex|opencode)["'`]/;

/**
 * Files the kind-literal rule does not read, each with the reason.
 *
 * The pattern stays as strict as it is; a legitimate use of the same word is
 * listed here by exact path instead.
 */
export const KIND_LITERAL_EXEMPT = new Map([
  [
    "packages/client-runtime/src/keybindings.ts",
    '"cmd" is the macOS Command key in a shortcut like "cmd+k", not a connector kind',
  ],
]);

/**
 * Concrete-connector leaks in a non-test source file of the renderer, the
 * client runtime or the server: an import of a connector package, or a quoted
 * connector kind.
 *
 * Tests are exempt — `cmdConformance.test.ts`, `attachmentTurn.test.ts`,
 * `boot.test.ts` and the end-to-end harness under `test/` assemble the real
 * connector on purpose — and so is the composition root, `boot.ts`.
 */
export const connectorLeaks = (relativePath, text) => {
  if (
    !CONNECTOR_NEUTRAL_ROOTS.some((root) => relativePath.startsWith(root)) ||
    !SOURCE_FILE.test(relativePath) ||
    isTestFile(relativePath) ||
    relativePath === COMPOSITION_ROOT
  ) {
    return [];
  }
  const leaks = [];
  for (const { specifier, index } of importSpecifiers(text)) {
    const connectorPackage = CONNECTOR_PACKAGE.exec(specifier);
    if (connectorPackage !== null) {
      leaks.push({
        line: lineOf(text, index),
        message: `${connectorPackage[0]} is a concrete connector; only ${COMPOSITION_ROOT} and tests may import one`,
      });
    }
  }
  if (!KIND_LITERAL_EXEMPT.has(relativePath)) {
    text.split("\n").forEach((line, index) => {
      const kind = KIND_LITERAL.exec(line);
      if (kind !== null) {
        leaks.push({
          line: index + 1,
          message: `connector kind literal "${kind[1]}"; take the kind from the registry or the contracts instead`,
        });
      }
    });
  }
  return leaks;
};

// -------------------------------------------------------- renderer neutrality

/**
 * The exact patterns, and the one directory they do not apply to.
 *
 * `commandcode` matches the spaced spelling too. The one-word form was the
 * only thing the pattern caught, so "Command Code" walked straight through it
 * — and did, in the Skills page's own description, which named one connector
 * on a page that renders whichever connector is configured.
 */
const RENDERER_FORBIDDEN = [
  { name: "commandcode", pattern: /\bcommand\s*code\b/i },
  { name: '"cmd"', pattern: /"cmd"/ },
  { name: "claude", pattern: /\bclaude\b/i },
  { name: "codex", pattern: /\bcodex\b/i },
  { name: "opencode", pattern: /\bopencode\b/i },
];
const RENDERER_ROOT = "apps/web/src/";
const RENDERER_EXCLUDED = ["apps/web/src/components/ui/icons/"];

/**
 * Connector identity in a renderer file: its name, or — unless `text` is
 * `null` because the file is binary — its contents. Every file counts, not
 * only the source ones: a connector name reads the same in a CSS class, an
 * SVG title, a JSON label or a file name.
 */
export const rendererLeaks = (relativePath, text) => {
  if (
    !relativePath.startsWith(RENDERER_ROOT) ||
    RENDERER_EXCLUDED.some((excluded) => relativePath.startsWith(excluded))
  ) {
    return [];
  }
  const leaks = [];
  const basename = relativePath.split("/").at(-1);
  for (const { name, pattern } of RENDERER_FORBIDDEN) {
    if (pattern.test(basename)) {
      leaks.push({
        line: 1,
        message: `connector identity leaked into a renderer file name: ${name}`,
      });
    }
  }
  if (text !== null) {
    text.split("\n").forEach((line, index) => {
      for (const { name, pattern } of RENDERER_FORBIDDEN) {
        if (pattern.test(line)) {
          leaks.push({
            line: index + 1,
            message: `connector identity leaked into the renderer: ${name}`,
          });
        }
      }
    });
  }
  return leaks;
};

// ------------------------------------------------------------ reference names

/**
 * Names of other products this one was compared against while it was built.
 * They are kept base64-encoded so that the guard does not spell them, and
 * decoded once here; the tests build their inputs from the same list.
 */
export const REFERENCE_NAMES = [
  "enVzZQ==",
  "dDNjb2Rl",
  "dDMgY29kZQ==",
  "c3luYXJh",
  "b3BlbmNvZGV4",
].map((encoded) => atob(encoded));

/** Case-insensitive; a space in a name also matches `-`, `_` or nothing. */
const REFERENCE_PATTERNS = REFERENCE_NAMES.map(
  (name) => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s_-]*"), "i"),
);

const REFERENCE_ROOTS = ["apps/", "packages/", "scripts/"];

/** Top-level markdown only: `docs/plans/` is local notes, not the product. */
const REFERENCE_DOCS = /^docs\/[^/]+\.md$/;

/** Build output and dependencies: not written by us. */
export const REFERENCE_SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "dist-ssr", "out"]);

/** Whether the reference-name rule reads `relativePath` at all. */
export const referenceNameApplies = (relativePath) =>
  (REFERENCE_ROOTS.some((root) => relativePath.startsWith(root)) ||
    REFERENCE_DOCS.test(relativePath)) &&
  !relativePath.split("/").some((segment) => REFERENCE_SKIPPED_DIRECTORIES.has(segment));

/**
 * A reference-product name in a path or, unless `text` is `null` because the
 * file is binary, in its contents. Describe an idea in our own words instead.
 */
export const referenceNameLeaks = (relativePath, text) => {
  if (!referenceNameApplies(relativePath)) {
    return [];
  }
  const leaks = [];
  if (REFERENCE_PATTERNS.some((pattern) => pattern.test(relativePath))) {
    leaks.push({ line: 1, message: "a reference-product name in a file path" });
  }
  if (text !== null) {
    text.split("\n").forEach((line, index) => {
      if (REFERENCE_PATTERNS.some((pattern) => pattern.test(line))) {
        leaks.push({
          line: index + 1,
          message: "a reference-product name; describe the idea in our own words",
        });
      }
    });
  }
  return leaks;
};

// ----------------------------------------------------------- bold icons

/** Where the bold-icon rule reads: every `.tsx` file of an app or a package. */
const BOLD_ICON_FILE = /^(?:apps|packages)\/.+\.tsx$/;

/** A value import from the icon package, the only place icon components come from. */
const HONEYICONS_IMPORT = /\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*["']@honeyicons\/react["']/g;

/**
 * The local names a file binds to Honeyicons components, each mapped to the
 * export it imports: every value specifier of an import from
 * `@honeyicons/react`, keyed by its alias when it has one (`Close as
 * CloseIcon` maps `CloseIcon` to `Close`). Type-only imports and specifiers
 * (`type HoneyIcon`) are not components and are left out.
 */
export const honeyiconNames = (text) => {
  const names = new Map();
  for (const match of text.matchAll(HONEYICONS_IMPORT)) {
    if (match[1] !== undefined) {
      continue;
    }
    for (const raw of match[2].split(",")) {
      const specifier = raw.trim();
      if (specifier === "" || /^type\s/.test(specifier)) {
        continue;
      }
      const [imported, local = imported] = specifier.split(/\s+as\s+/).map((part) => part.trim());
      names.set(local, imported);
    }
  }
  return names;
};

/**
 * A brand logo in colour: every `*Color` export of the package is a brand
 * `-color` logo, drawn identically in both variants with the brand's own
 * fills, so the variant means nothing for it.
 */
const BRAND_COLOR_EXPORT = /Color$/;

/**
 * The attribute text of the JSX opening that starts at `start` (just past the
 * tag name), up to its closing `>`. Braces and quoted strings are skipped, so
 * an arrow function or a `>` inside a class name does not end the tag early.
 */
const openingAttributes = (text, start) => {
  let depth = 0;
  let quote = null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    } else if (char === ">" && depth === 0) {
      return text.slice(start, index);
    }
  }
  return text.slice(start);
};

const BOLD_VARIANT = /(?:^|\s)variant=(?:"bold"|'bold'|\{\s*["']bold["']\s*\})/;
const SPREAD_ATTRIBUTE = /\{\s*\.\.\./;

/**
 * JSX renderings of a Honeyicons component without `variant="bold"`.
 *
 * Every icon ships a linear and a bold drawing and renders linear unless told
 * otherwise; the package has no provider for a default, so the app-wide
 * choice of bold is spelled on each element. An element that spreads props
 * passes: the spread is where the caller's `variant="bold"` arrives. A tag is
 * any `<Name` that is not preceded by an identifier character, which keeps
 * type arguments such as `Record<string, Name>` out.
 *
 * Brand colour logos are exempt: an element whose imported export ends in
 * `Color` (`ZedColor`, `ClaudeCodeColor`) passes without the prop, under an
 * alias too, since it draws the same either way. The match is on the export,
 * so an ordinary icon aliased to a `...Color` name is still read. Monochrome
 * brand logos stay under the rule: some (meta, instagram) are outlines in
 * linear and the official mark is the bold drawing.
 */
export const boldIconLeaks = (relativePath, text) => {
  if (!BOLD_ICON_FILE.test(relativePath)) {
    return [];
  }
  const names = honeyiconNames(text);
  if (names.size === 0) {
    return [];
  }
  const leaks = [];
  for (const match of text.matchAll(/(?<![\w$.])<([A-Z][\w$]*)(?=[\s/>])/g)) {
    const name = match[1];
    const imported = names.get(name);
    if (imported === undefined || BRAND_COLOR_EXPORT.test(imported)) {
      continue;
    }
    const attributes = openingAttributes(text, match.index + match[0].length);
    if (!BOLD_VARIANT.test(attributes) && !SPREAD_ATTRIBUTE.test(attributes)) {
      leaks.push({
        line: lineOf(text, match.index),
        message: `<${name}> renders the linear icon; add variant="bold" (icons render the bold variant app-wide)`,
      });
    }
  }
  return leaks;
};

// -------------------------------------------------------- padding asymmetry

/**
 * Where the padding rule reads: the renderer, the design system and the site,
 * in `.ts` and `.tsx` source (class lists also live in plain `.ts` helpers).
 */
const PADDING_FILE = /^(?:apps\/(?:web|site)|packages\/ui)\/.+\.tsx?$/;

/** A string literal in any quote style; class lists live in these. */
const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/**
 * A padding utility, once its variants and `!` are gone: all sides (`p`), an
 * axis (`px`, `py`) or one side (`ps`, `pe`, `pl`, `pr`, `pt`, `pb`), on the
 * spacing scale, `px`, an arbitrary `[value]` or a `(--variable)`.
 */
const PADDING_UTILITY = /^(p|px|py|ps|pe|pl|pr|pt|pb)-(\d+(?:\.\d+)?|px|\[[^\]]+\]|\([^)]+\))$/;

/** Which box sides each padding utility sets. `ps`/`pe` are `pl`/`pr` in LTR. */
const PADDING_SIDES = {
  p: ["left", "right", "top", "bottom"],
  px: ["left", "right"],
  py: ["top", "bottom"],
  ps: ["left"],
  pl: ["left"],
  pe: ["right"],
  pr: ["right"],
  pt: ["top"],
  pb: ["bottom"],
};

/**
 * The largest vertical padding, in spacing steps (16px), an element's inset
 * takes. Above it the padding spaces a page or section, whose vertical
 * breathing room is meant to exceed its gutters.
 */
const ELEMENT_INSET_MAX = 4;

/**
 * A square box, where padding does not shape it: `size-*`, `aspect-square`,
 * or a height and width (`h-*`, `w-*`) that the state checks come out equal.
 * `rounded-full` alone is not one; on a box wider than tall it draws a pill,
 * a chip or badge the rule covers. It is round only with a square.
 */
const SHAPE_UTILITY = /^(?:size-.+|aspect-square|([hw])-(\d+(?:\.\d+)?|px|\[[^\]]+\]))$/;

/** Calls whose string arguments add up to one class list. */
const CLASS_CALL = /(?<![\w$.])(cn|cva|clsx|cx|twMerge)\(/g;

/**
 * Marks a container (a menu, dialog, panel, list) whose even inset is
 * intended: a line or block comment that opens with `padding-ok: <why>`.
 * The reason is required, and the words in a string or JSX text do not count.
 */
const PADDING_ALLOW = /^(?:\/\/|\/\*)\s*padding-ok:\s*[^\s*]/;

/** A block or line comment. A `//` right after `:` or a quote is a URL, not a comment. */
const COMMENT = /\/\*[\s\S]*?\*\/|(?<![:"'`\w])\/\/[^\n]*/g;

/**
 * `text` with its comments blanked to spaces, newlines kept so line numbers
 * hold. A class name quoted in a comment is not a class list, and a stray
 * backtick in one must not pair with a later string.
 */
const withoutComments = (text) =>
  text.replace(COMMENT, (comment) => comment.replace(/[^\n]/g, " "));

/**
 * A class token split into its variant (`""` for none, `hover`, `sm`,
 * `group-data-[collapsible=icon]`) and its utility without `!`. The split is
 * at the last `:` outside brackets, so `[&>svg]:p-1` keeps its selector.
 */
const splitToken = (token) => {
  let depth = 0;
  let split = -1;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[" || char === "(") {
      depth += 1;
    } else if (char === "]" || char === ")") {
      depth -= 1;
    } else if (char === ":" && depth === 0) {
      split = index;
    }
  }
  return {
    variant: split === -1 ? "" : token.slice(0, split),
    utility: token.slice(split + 1).replace(/^!|!$/g, ""),
  };
};

/** A padding value as a number of spacing steps, or the raw text when arbitrary. */
const paddingSize = (value) => {
  if (value === "px") {
    return 0.25;
  }
  return /^\d/.test(value) ? Number(value) : value;
};

/**
 * The value an element's horizontal and vertical padding share, if they come
 * out equal, plus the vertical value (`taller`) when the vertical padding is
 * larger instead; `undefined` when the vertical padding is the smaller one.
 *
 * `tokens` is one class list in cascade order. Unprefixed utilities set the
 * resting box; each variant (`hover:`, `sm:`, `data-*:`) is judged on the
 * resting box with its own padding on top, so `px-2 py-1 sm:py-2` fails
 * under `sm`. The narrowest horizontal side is compared with the tallest
 * vertical one, so `py-2 pr-2 pl-2.5` fails while `px-3 pt-5 pb-2` (a
 * section gap on top) passes. A box whose every vertical side is larger than
 * its narrowest horizontal one, like `px-2 py-3`, fails too, while its
 * vertical padding is on an element's scale (`ELEMENT_INSET_MAX`); a page or
 * section at `px-8 py-10` passes, and so does zero horizontal padding. A box
 * that is square in the same state (`SHAPE_UTILITY`), round or not, passes,
 * and so does zero padding.
 */
export const equalPadding = (tokens) => {
  const states = new Map([["", { padding: [], shaped: false, h: undefined, w: undefined }]]);
  for (const token of tokens) {
    if (token === "") {
      continue;
    }
    const { variant, utility } = splitToken(token);
    const state = states.get(variant) ?? { padding: [], shaped: false, h: undefined, w: undefined };
    states.set(variant, state);
    const padding = PADDING_UTILITY.exec(utility);
    if (padding !== null) {
      state.padding.push([padding[1], padding[2]]);
    } else {
      const shape = SHAPE_UTILITY.exec(utility);
      if (shape?.[1] === undefined) {
        state.shaped ||= shape !== null;
      } else {
        state[shape[1]] = shape[2];
      }
    }
  }
  const resting = states.get("");
  const square = (state) => {
    const h = state.h ?? resting.h;
    const w = state.w ?? resting.w;
    return state.shaped || (h !== undefined && h === w);
  };
  for (const [variant, state] of states) {
    if (resting.shaped || square(state) || (variant !== "" && state.padding.length === 0)) {
      continue;
    }
    const sides = {};
    for (const [utility, value] of variant === ""
      ? resting.padding
      : [...resting.padding, ...state.padding]) {
      for (const side of PADDING_SIDES[utility]) {
        sides[side] = paddingSize(value);
      }
    }
    const horizontal = [sides.left, sides.right].filter((size) => size !== undefined);
    const vertical = [sides.top, sides.bottom].filter((size) => size !== undefined);
    if (horizontal.length === 0 || vertical.length === 0) {
      continue;
    }
    const numeric = [...horizontal, ...vertical].every((size) => typeof size === "number");
    const narrowest = numeric
      ? Math.min(...horizontal)
      : horizontal.find((size) => vertical.includes(size));
    const tallest = numeric ? Math.max(...vertical) : narrowest;
    if (narrowest !== undefined && narrowest === tallest && narrowest !== 0) {
      return { variant, value: String(narrowest) };
    }
    const shortest = numeric ? Math.min(...vertical) : undefined;
    if (numeric && narrowest !== 0 && shortest > narrowest && shortest <= ELEMENT_INSET_MAX) {
      return { variant, value: String(narrowest), taller: String(shortest) };
    }
  }
  return undefined;
};

/** The index just past the `)` that closes the call opened at `open`, skipping strings. */
const callEnd = (text, open, literals) => {
  let depth = 0;
  let literal = literals.findIndex((candidate) => candidate.start >= open);
  for (let index = open; index < text.length; index += 1) {
    if (literal !== -1 && literal < literals.length && index === literals[literal].start) {
      index = literals[literal].end - 1;
      literal += 1;
      continue;
    }
    const char = text[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return text.length;
};

const classTokens = (literal) => literal.classes.split(/\s+/);

/**
 * Class lists whose horizontal and vertical padding come out equal.
 *
 * Elements read as balanced when their vertical padding is smaller than the
 * horizontal, so buttons, inputs, rows, chips, toasts and small cards spell
 * `px-3 py-1.5`, never `p-2` or `px-2 py-2`. Every string literal is read as
 * a class list (see `equalPadding` for the cascade, variants and exemptions),
 * and so is the sum of the literals one `cn()`/`clsx()` call merges and each
 * `cva()` value on top of its base, so `cn("px-2", "py-2")` fails too. A
 * `// padding-ok: <why>` comment (`PADDING_ALLOW`) exempts a container (a
 * menu, dialog or panel) whose even inset is intended. It sits on the
 * reported line or the line above it; for a `cn()`/`clsx()` merge, which is
 * one element, the line that opens the call counts too. A `cva()` holds
 * several elements' values, so its opening line exempts only the base, and a
 * variant value is exempted beside that value.
 */
export const equalPaddingLeaks = (relativePath, text) => {
  if (!PADDING_FILE.test(relativePath)) {
    return [];
  }
  const source = withoutComments(text);
  const literals = [...source.matchAll(STRING_LITERAL)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    classes: match[0].slice(1, -1),
  }));
  const allowLines = new Set();
  for (const comment of text.matchAll(COMMENT)) {
    if (PADDING_ALLOW.test(comment[0])) {
      const first = lineOf(text, comment.index);
      const last = lineOf(text, comment.index + comment[0].length - 1);
      for (let line = first; line <= last; line += 1) {
        allowLines.add(line);
      }
    }
  }
  const allowed = (...lineNumbers) =>
    lineNumbers.some(
      (line) => line !== undefined && (allowLines.has(line) || allowLines.has(line - 1)),
    );
  const leaks = new Map();
  const judge = (tokens, line, callLine) => {
    const equal = equalPadding(tokens);
    if (equal === undefined || leaks.has(line) || allowed(line, callLine)) {
      return;
    }
    const state = equal.variant === "" ? "" : ` under ${equal.variant}:`;
    const found =
      equal.taller === undefined
        ? `equal padding${state} (x and y both ${equal.value})`
        : `taller than wide padding${state} (x ${equal.value}, y ${equal.taller})`;
    leaks.set(line, {
      line,
      message: `${found}; give the element less vertical padding than horizontal, e.g. px-3 py-1.5, or mark a container with a "// padding-ok: <why>" comment`,
    });
  };
  const calls = [...source.matchAll(CLASS_CALL)].map((match) => {
    const open = match.index + match[0].length - 1;
    const end = callEnd(source, open, literals);
    return {
      name: match[1],
      line: lineOf(text, match.index),
      literals: literals.filter((literal) => literal.start > open && literal.end <= end),
      open,
    };
  });
  const shapedBy = (group) =>
    group.flatMap(classTokens).filter((token) => SHAPE_UTILITY.test(splitToken(token).utility));
  for (const literal of literals) {
    const call = calls.findLast((candidate) => candidate.literals.includes(literal));
    // A square or round box can be spelled in another argument of the same
    // merge; a cva value only shares its box with the base, checked below.
    const siblings = call === undefined || call.name === "cva" ? [] : call.literals;
    const callAllows = call !== undefined && (call.name !== "cva" || call.literals[0] === literal);
    judge(
      [...shapedBy(siblings), ...classTokens(literal)],
      lineOf(text, literal.start),
      callAllows ? call.line : undefined,
    );
  }
  for (const call of calls) {
    if (call.literals.length < 2) {
      continue;
    }
    const last = call.literals.findLast((literal) =>
      classTokens(literal).some((token) => PADDING_UTILITY.test(splitToken(token).utility)),
    );
    if (last === undefined) {
      continue;
    }
    if (call.name === "cva") {
      // The base is the first argument; every other literal is a variant value on top of it.
      const [base, ...values] = call.literals;
      if (source.slice(call.open + 1, base.start).trim() !== "") {
        continue;
      }
      for (const value of values) {
        judge([...classTokens(base), ...classTokens(value)], lineOf(text, value.start));
      }
    } else {
      judge(call.literals.flatMap(classTokens), lineOf(text, last.start), call.line);
    }
  }
  return [...leaks.values()].sort((a, b) => a.line - b.line);
};

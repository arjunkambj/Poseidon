/**
 * What a fenced code block in markdown says about itself, read off the parts
 * react-markdown hands the `pre` override: the `language-x` class on its
 * `code` child and the fence meta (the info string after the first word),
 * which mdast-util-to-hast keeps on that child's `data.meta`.
 *
 * - `language` is an id the highlighter bundles, or `"text"` for anything it
 *   does not know, so an unknown fence never asks the worker pool for a
 *   grammar it cannot load. A word the table below does not name is looked up
 *   in Shiki's own list of bundled languages and their aliases — the list the
 *   pool resolves grammars from — so `r`, `perl` or `solidity` highlight too;
 * - `fileName` is set when the fence names a file: `title="x"` (or
 *   `filename=`/`file=`, either quote), a bare path-like word after the
 *   language (`ts src/app.ts`), `lang:path` (`ts:src/app.ts`), or a path as
 *   the only word (`src/app.ts`), whose extension then picks the language;
 * - `label` is what the block's header shows: the file name when there is
 *   one, otherwise the language's display name, or the unknown word as written.
 *
 * Also here: the size cap above which a block renders plain. Where a fence
 * still streaming opens is the block splitter's to say (`markdown-blocks.ts`),
 * since it already tracks every fence the way the parser does.
 */

import { bundledLanguagesInfo } from "shiki";

/** Blocks above either cap render as plain text: tokenizing them would stall a worker. */
export const HIGHLIGHT_MAX_CHARS = 20_000;
export const HIGHLIGHT_MAX_LINES = 1_000;

export interface CodeFenceInfo {
  readonly language: string;
  readonly fileName?: string;
  readonly label: string;
}

/**
 * Fence word → [highlighter language id, display name], for the languages an
 * agent writes most, with the display names and aliases we prefer. Keys are
 * lower case. Everything else Shiki bundles is found through `bundled`.
 */
const LANGUAGES: Readonly<Record<string, readonly [string, string]>> = (() => {
  const table: Record<string, readonly [string, string]> = {};
  const add = (id: string, label: string, aliases: ReadonlyArray<string>) => {
    for (const alias of [id, ...aliases]) {
      table[alias] = [id, label];
    }
  };
  add("typescript", "TypeScript", ["ts", "mts", "cts"]);
  add("tsx", "TSX", []);
  add("javascript", "JavaScript", ["js", "mjs", "cjs", "node"]);
  add("jsx", "JSX", []);
  add("json", "JSON", []);
  add("jsonc", "JSONC", []);
  add("json5", "JSON5", []);
  add("jsonl", "JSON Lines", ["ndjson"]);
  add("shellscript", "Shell", ["sh", "bash", "shell", "zsh", "fish"]);
  add("shellsession", "Terminal", ["console", "terminal"]);
  add("powershell", "PowerShell", ["ps1", "pwsh"]);
  add("yaml", "YAML", ["yml"]);
  add("toml", "TOML", []);
  add("ini", "INI", ["cfg"]);
  add("dotenv", ".env", ["env"]);
  add("markdown", "Markdown", ["md"]);
  add("mdx", "MDX", []);
  add("html", "HTML", ["htm"]);
  add("xml", "XML", ["svg", "plist"]);
  add("css", "CSS", []);
  add("scss", "SCSS", []);
  add("less", "Less", []);
  add("sql", "SQL", []);
  add("graphql", "GraphQL", ["gql"]);
  add("python", "Python", ["py"]);
  add("rust", "Rust", ["rs"]);
  add("go", "Go", ["golang"]);
  add("c", "C", ["h"]);
  add("cpp", "C++", ["c++", "cc", "hpp", "cxx"]);
  add("csharp", "C#", ["cs", "c#"]);
  add("java", "Java", []);
  add("kotlin", "Kotlin", ["kt", "kts"]);
  add("swift", "Swift", []);
  add("ruby", "Ruby", ["rb"]);
  add("php", "PHP", []);
  add("lua", "Lua", []);
  add("dart", "Dart", []);
  add("scala", "Scala", []);
  add("elixir", "Elixir", ["ex", "exs"]);
  add("haskell", "Haskell", ["hs"]);
  add("zig", "Zig", []);
  add("nix", "Nix", []);
  add("vue", "Vue", []);
  add("svelte", "Svelte", []);
  add("astro", "Astro", []);
  add("prisma", "Prisma", []);
  add("proto", "Protocol Buffers", ["protobuf"]);
  add("hcl", "HCL", []);
  add("terraform", "Terraform", ["tf"]);
  add("dockerfile", "Dockerfile", ["docker"]);
  add("make", "Makefile", ["makefile", "mk"]);
  add("nginx", "nginx", []);
  add("regex", "Regex", ["regexp"]);
  add("diff", "Diff", ["patch"]);
  add("log", "Log", []);
  add("text", "Text", ["txt", "plain", "plaintext"]);
  return table;
})();

/** File names whose language comes from the whole name, not an extension. */
const NAMED_FILES: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "make",
  ".env": "dotenv",
};

const TEXT = LANGUAGES["text"]!;

let bundled: ReadonlyMap<string, readonly [string, string]> | undefined;

/** Every id and alias Shiki bundles, built on first use. */
const bundledLanguage = (word: string): readonly [string, string] | undefined => {
  if (bundled === undefined) {
    const table = new Map<string, readonly [string, string]>();
    for (const info of bundledLanguagesInfo) {
      for (const alias of [info.id, ...(info.aliases ?? [])]) {
        table.set(alias.toLowerCase(), [info.id, info.name]);
      }
    }
    bundled = table;
  }
  return bundled.get(word);
};

const lookup = (word: string): readonly [string, string] | undefined =>
  Object.prototype.hasOwnProperty.call(LANGUAGES, word) ? LANGUAGES[word] : bundledLanguage(word);

/** A word that names a file: it has a directory, or a name and an extension. */
const looksLikePath = (word: string): boolean =>
  !word.includes("=") &&
  !word.startsWith("{") &&
  (word.includes("/") || /^[\w.-]*\w\.[A-Za-z0-9]+$/.test(word));

const languageOfFile = (fileName: string): readonly [string, string] | undefined => {
  const base = fileName.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const named = NAMED_FILES[base];
  if (named !== undefined) {
    return lookup(named);
  }
  const dot = base.lastIndexOf(".");
  return dot > 0 ? lookup(base.slice(dot + 1)) : undefined;
};

/** Languages that are prose or plain text, not code. */
const PROSE = new Set(["text", "markdown", "mdx", "log"]);

/** Whether a file's name says it holds code — a file chip picks its icon by it. */
export const isCodeFile = (path: string): boolean => {
  const language = languageOfFile(path)?.[0];
  return language !== undefined && !PROSE.has(language);
};

/**
 * The highlighter language a file's name picks, or `undefined` when its
 * extension (or whole name, for a Dockerfile or Makefile) names none, or
 * names plain text — the Files preview highlights only what this answers.
 */
export const languageForPath = (path: string): string | undefined => {
  const language = languageOfFile(path)?.[0];
  return language === "text" ? undefined : language;
};

/** `title="x"`, `filename='x'` or `file=x` anywhere in the meta. */
const titleInMeta = (meta: string): string | undefined => {
  const match = /(?:^|\s)(?:title|filename|file)=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
};

/** The fence's first word, from `language-x` among the `code` element's classes. */
const fenceWord = (className: unknown): string | undefined => {
  const classes = Array.isArray(className)
    ? className
    : typeof className === "string"
      ? className.split(/\s+/)
      : [];
  for (const name of classes) {
    if (typeof name === "string" && name.startsWith("language-") && name.length > 9) {
      return name.slice(9);
    }
  }
  return undefined;
};

export const codeFenceInfo = (className: unknown, meta: string | undefined): CodeFenceInfo => {
  let word = fenceWord(className);
  let fileName = meta === undefined ? undefined : titleInMeta(meta);

  // `lang:path` packs both into the first word.
  if (word !== undefined && fileName === undefined) {
    const colon = word.indexOf(":");
    if (colon > 0 && looksLikePath(word.slice(colon + 1))) {
      fileName = word.slice(colon + 1);
      word = word.slice(0, colon);
    }
  }
  // A path as the only word: there is no language, only a file.
  if (word !== undefined && lookup(word.toLowerCase()) === undefined && looksLikePath(word)) {
    fileName ??= word;
    word = undefined;
  }
  if (fileName === undefined && meta !== undefined) {
    fileName = meta.split(/\s+/).find(looksLikePath);
  }

  const known = word === undefined ? undefined : lookup(word.toLowerCase());
  const [language, name] =
    known ?? (fileName === undefined ? undefined : languageOfFile(fileName)) ?? TEXT;
  // An unknown word is still what the author called the block; show it as written.
  const label = fileName ?? (word !== undefined && known === undefined ? word : name);
  return fileName === undefined ? { language, label } : { language, fileName, label };
};

/** Whether a block is small enough to hand to the highlighter. */
export const highlightable = (code: string): boolean => {
  if (code.length > HIGHLIGHT_MAX_CHARS) {
    return false;
  }
  let lines = 1;
  for (let index = code.indexOf("\n"); index !== -1; index = code.indexOf("\n", index + 1)) {
    lines += 1;
    if (lines > HIGHLIGHT_MAX_LINES) {
      return false;
    }
  }
  return true;
};

/** The text of a hast subtree, the way `hast-util-to-string` reads it. */
export interface HastLike {
  readonly type: string;
  readonly value?: string;
  readonly children?: ReadonlyArray<HastLike>;
}

export const hastText = (node: HastLike): string =>
  node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(hastText).join("");

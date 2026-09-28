import { describe, expect, it } from "vitest";

import {
  allowedImportsFor,
  boldIconLeaks,
  connectorLeaks,
  equalPaddingLeaks,
  honeyiconNames,
  KIND_LITERAL_EXEMPT,
  REFERENCE_NAMES,
  referenceNameLeaks,
  rendererLeaks,
} from "./boundary-rules.mjs";

const lines = (leaks) => leaks.map((leak) => leak.line);

describe("allowedImportsFor", () => {
  it("keeps connector packages out of the server's production files", () => {
    const handlers = allowedImportsFor("apps/server/src/rpc/handlers.ts", "apps/server");
    expect(handlers).not.toContain("connector-cmd");
    expect(handlers).not.toContain("connector-claude");
  });

  it("lets the composition root and server tests import the real connectors", () => {
    for (const connector of ["connector-cmd", "connector-claude"]) {
      expect(allowedImportsFor("apps/server/src/boot.ts", "apps/server")).toContain(connector);
      expect(
        allowedImportsFor("apps/server/src/hooks/cmdConformance.test.ts", "apps/server"),
      ).toContain(connector);
      expect(allowedImportsFor("apps/server/test/e2e/harness.ts", "apps/server")).toContain(
        connector,
      );
    }
  });

  it("lets the Claude Code connector's tests, and only its tests, import testkit", () => {
    const workspace = "packages/connector-claude";
    expect(allowedImportsFor(`${workspace}/src/session.ts`, workspace)).not.toContain("testkit");
    expect(allowedImportsFor(`${workspace}/src/session.test.ts`, workspace)).toContain("testkit");
    expect(allowedImportsFor(`${workspace}/test/replay.ts`, workspace)).toContain("testkit");
    expect(
      allowedImportsFor("packages/connector-cmd/src/session.test.ts", "packages/connector-cmd"),
    ).not.toContain("testkit");
  });

  it("gives test extras only to tests, and nothing to a workspace with no rule", () => {
    expect(allowedImportsFor("apps/server/src/main.ts", "apps/server")).not.toContain("testkit");
    expect(allowedImportsFor("apps/server/src/main.test.ts", "apps/server")).toContain("testkit");
    expect(allowedImportsFor("apps/desktop/src/main/index.ts", "apps/desktop")).not.toContain(
      "testkit",
    );
    expect(
      allowedImportsFor("apps/desktop/src/main/browser/bridgeSession.test.ts", "apps/desktop"),
    ).toEqual(["contracts", "shared", "testkit"]);
    expect(
      allowedImportsFor("packages/connector-next/src/a.ts", "packages/connector-next"),
    ).toEqual(["connector-sdk", "contracts", "shared"]);
    expect(allowedImportsFor("apps/unknown/src/a.ts", "apps/unknown")).toBeUndefined();
  });
});

describe("connectorLeaks", () => {
  const importing = (specifier) => `import { x } from "${specifier}";\n`;

  it("fails a server file that imports a concrete connector", () => {
    const leaks = connectorLeaks(
      "apps/server/src/rpc/handlers.ts",
      `// the handlers\n${importing("@poseidon/connector-cmd/definition")}`,
    );
    expect(lines(leaks)).toEqual([2]);
    expect(leaks[0].message).toContain("@poseidon/connector-cmd");
  });

  it("catches dynamic imports and any connector package but the sdk", () => {
    expect(
      connectorLeaks("apps/web/src/lib/a.ts", "await import(`@poseidon/connector-next/x`);\n"),
    ).toHaveLength(1);
    expect(
      connectorLeaks("packages/client-runtime/src/a.ts", importing("@poseidon/connector-sdk/ids")),
    ).toEqual([]);
  });

  it("passes the composition root", () => {
    expect(
      connectorLeaks(
        "apps/server/src/boot.ts",
        `${importing("@poseidon/connector-cmd/definition")}const kind = "cmd";\n`,
      ),
    ).toEqual([]);
  });

  it("passes server tests and the end-to-end harness", () => {
    const source = `${importing("@poseidon/connector-cmd/definition")}const kind = "cmd";\n`;
    expect(connectorLeaks("apps/server/src/hooks/cmdConformance.test.ts", source)).toEqual([]);
    expect(connectorLeaks("apps/server/test/e2e/harness.ts", source)).toEqual([]);
  });

  it("fails a quoted connector kind in the server and the renderer", () => {
    expect(
      lines(
        connectorLeaks("apps/server/src/rpc/services.ts", 'const a = 1;\nif (kind === "cmd") {}\n'),
      ),
    ).toEqual([2]);
    expect(connectorLeaks("apps/web/src/lib/routing.ts", 'const x = { kind: "codex" };\n')).toEqual(
      [expect.objectContaining({ line: 1 })],
    );
    expect(connectorLeaks("apps/web/src/lib/routing.ts", "const x = `opencode`;\n")).toHaveLength(
      1,
    );
    expect(connectorLeaks("apps/server/src/a.ts", "const x = 'claude';\n")).toHaveLength(1);
  });

  it("passes harness config paths, which are not kinds", () => {
    expect(
      connectorLeaks(
        "apps/server/src/permissions/sensitivePaths.ts",
        'const dirs = new Set([".claude", ".codex", ".config/opencode"]);\n',
      ),
    ).toEqual([]);
  });

  it("exempts the keyboard modifier in keybindings by exact path only", () => {
    const source = 'const modifiers = ["cmd", "ctrl"];\n';
    expect(KIND_LITERAL_EXEMPT.has("packages/client-runtime/src/keybindings.ts")).toBe(true);
    expect(connectorLeaks("packages/client-runtime/src/keybindings.ts", source)).toEqual([]);
    expect(connectorLeaks("packages/client-runtime/src/shortcuts.ts", source)).toHaveLength(1);
  });

  it("does not read other workspaces", () => {
    expect(
      connectorLeaks("packages/connector-cmd/src/definition.ts", 'export const kind = "cmd";\n'),
    ).toEqual([]);
  });
});

describe("rendererLeaks", () => {
  it("fails a harness name as a word in any renderer file", () => {
    expect(rendererLeaks("apps/web/src/lib/a.ts", "// talks to codex\n")).toHaveLength(1);
    expect(rendererLeaks("apps/web/src/lib/a.css", ".opencode-row {}\n")).toHaveLength(1);
    expect(rendererLeaks("apps/web/src/lib/codex.ts", null)).toHaveLength(1);
  });

  it("skips the icon set and files outside the renderer", () => {
    expect(rendererLeaks("apps/web/src/components/ui/icons/claude.svg", "claude")).toEqual([]);
    expect(rendererLeaks("apps/server/src/a.ts", "claude")).toEqual([]);
  });
});

describe("referenceNameLeaks", () => {
  const variants = (name) => [name, name.toUpperCase(), name[0].toUpperCase() + name.slice(1)];

  it("fails each reference name in contents, whatever its case", () => {
    for (const name of REFERENCE_NAMES) {
      for (const spelling of variants(name)) {
        const leaks = referenceNameLeaks("packages/shared/src/a.ts", `ok\n// like ${spelling}\n`);
        expect(lines(leaks), spelling).toEqual([2]);
      }
    }
  });

  it("fails each reference name in a file or directory name", () => {
    for (const name of REFERENCE_NAMES) {
      const slug = name.replace(/ /g, "-");
      expect(referenceNameLeaks(`apps/web/src/${slug}.ts`, "ok\n"), name).toHaveLength(1);
      expect(referenceNameLeaks(`scripts/${slug}/notes.txt`, null), name).toHaveLength(1);
    }
  });

  it("reads the top-level docs but not docs/plans", () => {
    const text = `see ${REFERENCE_NAMES[0]}\n`;
    expect(referenceNameLeaks("docs/architecture.md", text)).toHaveLength(1);
    expect(referenceNameLeaks("docs/plans/harness-plan.md", text)).toEqual([]);
    expect(referenceNameLeaks("docs/launch/post.txt", text)).toEqual([]);
  });

  it("skips dependencies and build output", () => {
    const text = `${REFERENCE_NAMES[1]}\n`;
    expect(referenceNameLeaks("apps/web/node_modules/x/index.js", text)).toEqual([]);
    expect(referenceNameLeaks("apps/web/dist/a.js", text)).toEqual([]);
    expect(referenceNameLeaks("apps/desktop/out/main.js", text)).toEqual([]);
  });

  it("reads the recordings too: a scrubbed capture must not name one either", () => {
    const text = `{"type":"system","skills":["${REFERENCE_NAMES[0]}-helper"]}\n`;
    expect(
      lines(referenceNameLeaks("packages/testkit/fixtures/claude/a/invocation-1.ndjson", text)),
    ).toEqual([1]);
    expect(
      referenceNameLeaks(
        `packages/testkit/fixtures/cmd/${REFERENCE_NAMES[4]}/manifest.json`,
        "{}\n",
      ),
    ).toHaveLength(1);
  });

  it("reads the hand-written contract fixtures, which are not recordings", () => {
    const text = `{ "displayName": "${REFERENCE_NAMES[1]}" }\n`;
    expect(referenceNameLeaks("packages/contracts/fixtures/rpc/a.json", text)).toHaveLength(1);
  });

  it("passes ordinary text, including harness names we integrate", () => {
    expect(
      referenceNameLeaks("docs/architecture.md", "Command Code, Claude Code, Codex, OpenCode\n"),
    ).toEqual([]);
  });
});

describe("boldIconLeaks", () => {
  const file = "apps/web/src/components/a.tsx";
  const icons = 'import { type HoneyIcon, Bell, Close as CloseIcon } from "@honeyicons/react";\n';
  const brands =
    'import { Zed, ZedColor, ZedColor as Logo, Bell as BellColor } from "@honeyicons/react";\n';

  it("fails an imported icon rendered without the bold variant, and says what to do", () => {
    const leaks = boldIconLeaks(file, `${icons}const a = <Bell className="size-4" />;\n`);
    expect(lines(leaks)).toEqual([2]);
    expect(leaks[0].message).toContain('add variant="bold"');
  });

  it("passes the bold variant in any attribute position and quote style", () => {
    expect(boldIconLeaks(file, `${icons}const a = <Bell variant="bold" />;\n`)).toEqual([]);
    expect(boldIconLeaks(file, `${icons}const a = <Bell size={16} variant='bold'/>;\n`)).toEqual(
      [],
    );
    expect(boldIconLeaks(file, `${icons}const a = <Bell variant={"bold"}>x</Bell>;\n`)).toEqual([]);
  });

  it("fails the linear variant, spelled out", () => {
    expect(boldIconLeaks(file, `${icons}const a = <Bell variant="linear" />;\n`)).toHaveLength(1);
  });

  it("reads a multi-line opening to its end, past braces and quoted angle brackets", () => {
    const passing = `${icons}const a = (\n  <Bell\n    onClick={() => a > b}\n    title="a > b"\n    variant="bold"\n  />\n);\n`;
    expect(boldIconLeaks(file, passing)).toEqual([]);
    const failing = `${icons}const a = (\n  <Bell\n    onClick={() => a > b}\n  />\n);\nconst b = <p variant="bold" />;\n`;
    expect(lines(boldIconLeaks(file, failing))).toEqual([3]);
  });

  it("follows an import alias and a multi-line import", () => {
    expect(lines(boldIconLeaks(file, `${icons}const a = <CloseIcon />;\n`))).toEqual([2]);
    const multiLine = 'import {\n  Bell,\n  Search,\n} from "@honeyicons/react";\n<Search />;\n';
    expect(lines(boldIconLeaks(file, multiLine))).toEqual([5]);
  });

  it("passes an icon that spreads props, which carry the variant", () => {
    expect(boldIconLeaks(file, `${icons}const a = <Bell {...props} />;\n`)).toEqual([]);
  });

  it("ignores other components, type arguments, closing tags and type-only imports", () => {
    expect(boldIconLeaks(file, `${icons}const a = <Button><BellRing /></Button>;\n`)).toEqual([]);
    expect(boldIconLeaks(file, `${icons}const m: Record<string, Bell> = {};\n`)).toEqual([]);
    expect(
      boldIconLeaks(file, 'import type { HoneyIcon } from "@honeyicons/react";\n<HoneyIcon />;\n'),
    ).toEqual([]);
    expect([...honeyiconNames(icons)]).toEqual([
      ["Bell", "Bell"],
      ["CloseIcon", "Close"],
    ]);
  });

  it("passes a brand colour logo without the variant, under its own name or an alias", () => {
    expect(boldIconLeaks(file, `${brands}const a = <ZedColor className="size-4" />;\n`)).toEqual(
      [],
    );
    expect(boldIconLeaks(file, `${brands}const a = <Logo />;\n`)).toEqual([]);
  });

  it("still reads a monochrome brand logo and an ordinary icon aliased to a Color name", () => {
    expect(lines(boldIconLeaks(file, `${brands}const a = <Zed />;\n`))).toEqual([2]);
    expect(lines(boldIconLeaks(file, `${brands}const a = <BellColor />;\n`))).toEqual([2]);
  });

  it("reads only .tsx files under apps/ and packages/", () => {
    const source = `${icons}<Bell />;\n`;
    expect(boldIconLeaks("packages/ui/src/components/sonner.tsx", source)).toHaveLength(1);
    expect(boldIconLeaks("apps/web/src/lib/a.ts", source)).toEqual([]);
    expect(boldIconLeaks("scripts/a.tsx", source)).toEqual([]);
  });
});

describe("equalPaddingLeaks", () => {
  const file = "packages/ui/src/components/a.tsx";
  const leaksIn = (source) => lines(equalPaddingLeaks(file, source));

  it("fails a class list whose x and y padding come out equal, and says what to do", () => {
    const leaks = equalPaddingLeaks(file, 'const a = "flex p-2";\nconst b = "px-3 py-3";\n');
    expect(lines(leaks)).toEqual([1, 2]);
    expect(leaks[0].message).toContain("px-3 py-1.5");
    expect(leaksIn('const a = "px-3 py-1.5";\nconst b = "px-2.5 py-2";\n')).toEqual([]);
  });

  it("reads every padding form: p, px/py, logical and physical sides, px, arbitrary values", () => {
    expect(leaksIn('const a = "ps-2 pe-2 pt-2 pb-2";\n')).toEqual([1]);
    expect(leaksIn('const a = "pl-2 pr-2 py-2";\n')).toEqual([1]);
    expect(leaksIn('const a = "px-2 pb-2";\n')).toEqual([1]);
    expect(leaksIn('const a = "px-px py-px";\n')).toEqual([1]);
    expect(leaksIn('const a = "p-[3px]";\n')).toEqual([1]);
    expect(leaksIn('const a = "p-(--inset)";\n')).toEqual([1]);
    expect(leaksIn('const a = "px-[4px] py-[2px]";\n')).toEqual([]);
  });

  it("compares the narrowest horizontal side with the tallest vertical one", () => {
    // A trailing button's side matches the vertical inset: still even.
    expect(leaksIn('const a = "py-1 pr-1 pl-3";\n')).toEqual([1]);
    expect(leaksIn('const a = "py-2 pr-2 pl-2.5";\n')).toEqual([1]);
    expect(leaksIn('const a = "py-0.5 pr-1.5 pl-3";\n')).toEqual([]);
    // A section gap on top is not an even inset.
    expect(leaksIn('const a = "px-2 pt-5 pb-1";\n')).toEqual([]);
  });

  it("fails an element with more vertical padding than horizontal, and says so", () => {
    const leaks = equalPaddingLeaks(file, 'const a = "px-2 py-3";\n');
    expect(lines(leaks)).toEqual([1]);
    expect(leaks[0].message).toContain("x 2, y 3");
    expect(leaksIn('const a = "px-1 py-2";\n')).toEqual([1]);
    expect(leaksIn('const a = "px-2 pt-3 pb-4";\n')).toEqual([1]);
    expect(leaksIn('const a = "px-2 py-1 sm:py-3";\n')).toEqual([1]);
    // One short vertical side is a gap on the other, not a tall inset.
    expect(leaksIn('const a = "px-2 pt-3 pb-1";\n')).toEqual([]);
    // A page or section's vertical room is meant to exceed its gutters.
    expect(leaksIn('const a = "px-8 py-10";\nconst b = "px-4 py-8";\n')).toEqual([]);
    // No horizontal inset: the box is not padded as an element.
    expect(leaksIn('const a = "px-0 py-1";\n')).toEqual([]);
  });

  it("follows the cascade inside one list", () => {
    expect(leaksIn('const a = "p-1 px-2";\n')).toEqual([]);
    expect(leaksIn('const a = "px-2 p-1";\n')).toEqual([1]);
    expect(leaksIn('const a = "p-2 py-1";\n')).toEqual([]);
    expect(leaksIn('const a = "p-0";\n')).toEqual([]);
    expect(leaksIn('const a = "px-0 py-0";\n')).toEqual([]);
    expect(leaksIn('const a = "p-2!";\n')).toEqual([1]);
    expect(leaksIn('const a = "!p-2";\n')).toEqual([1]);
    expect(leaksIn('const a = "px-2";\nconst b = "py-2";\n')).toEqual([]);
  });

  it("judges each variant on the resting box, and names it", () => {
    expect(leaksIn('const a = "px-2 py-1 hover:px-3";\n')).toEqual([]);
    const leaks = equalPaddingLeaks(file, 'const a = "px-2 py-1 sm:py-2";\n');
    expect(lines(leaks)).toEqual([1]);
    expect(leaks[0].message).toContain("under sm:");
    expect(leaksIn('const a = "px-3 py-1.5 has-data-[slot=kbd]:pr-1.5";\n')).toEqual([1]);
    expect(leaksIn('const a = "gap-1 [&>svg]:size-4 data-[open]:p-1";\n')).toEqual([1]);
    expect(leaksIn('const a = "hover:bg-muted md:px-4";\n')).toEqual([]);
  });

  it("passes square and round elements, in the state that makes them so", () => {
    expect(leaksIn('const a = "size-8 p-2";\n')).toEqual([]);
    expect(leaksIn('const a = "size-8! p-2";\n')).toEqual([]);
    expect(leaksIn('const a = "rounded-full size-6 p-1";\n')).toEqual([]);
    expect(leaksIn('const a = "aspect-square p-1.5";\n')).toEqual([]);
    expect(leaksIn('const a = "h-6 w-6 rounded-full p-1";\n')).toEqual([]);
    expect(leaksIn('const a = "h-6 w-[24px] p-1";\n')).toEqual([1]);
    expect(leaksIn('const a = "h-full w-full p-1";\n')).toEqual([1]);
    expect(leaksIn('const a = "h-6 w-8 p-1";\n')).toEqual([1]);
    expect(leaksIn('const a = "h-6 px-2 py-1 sm:w-6 sm:p-1";\n')).toEqual([]);
    expect(
      leaksIn(
        'const a = "px-2 py-1 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2!";\n',
      ),
    ).toEqual([]);
    // A size on a child selector does not make the element itself square.
    expect(leaksIn('const a = "p-2 [&_svg]:size-4";\n')).toEqual([1]);
    expect(leaksIn('const a = "rounded-lg p-2";\n')).toEqual([1]);
  });

  it("fails a pill: rounded-full on a box that is not square", () => {
    expect(leaksIn('const a = "rounded-full p-1";\n')).toEqual([1]);
    expect(leaksIn('const a = "rounded-full px-2 py-2";\n')).toEqual([1]);
    expect(leaksIn('const a = "h-6 rounded-full py-0.5 pr-0.5 pl-2";\n')).toEqual([1]);
    expect(leaksIn('const a = "rounded-full px-2 py-0.5";\n')).toEqual([]);
  });

  it("adds up the arguments of cn() and clsx(), and a square in one passes the rest", () => {
    expect(leaksIn('const a = cn("flex px-2", open && "py-2");\n')).toEqual([1]);
    expect(leaksIn('const a = cn(\n  "flex px-2",\n  "py-2",\n  className,\n);\n')).toEqual([3]);
    expect(leaksIn('const a = clsx("px-2", "py-1");\n')).toEqual([]);
    expect(leaksIn('const a = cn("size-7", "p-1");\n')).toEqual([]);
    expect(leaksIn('<div className={cn("p-1.5", className)} />\n')).toEqual([1]);
  });

  it("reads each cva() value on top of its base", () => {
    const source = [
      "const button = cva(",
      '  "inline-flex py-1.5",',
      "  {",
      "    variants: {",
      "      size: {",
      '        default: "h-7 px-2.5",',
      '        sm: "h-6 px-1.5",',
      '        icon: "size-7",',
      "      },",
      "    },",
      "  },",
      ");",
      "",
    ].join("\n");
    expect(leaksIn(source)).toEqual([7]);
    expect(leaksIn('const a = cva("", { variants: { size: { sm: "p-2" } } });\n')).toEqual([1]);
  });

  it("reads template literals and JSX attributes", () => {
    expect(leaksIn("const a = `${base} p-2`;\n")).toEqual([1]);
    expect(leaksIn('<pre className="rounded-lg bg-muted p-3 font-mono" />\n')).toEqual([1]);
    expect(leaksIn("<div className='px-4 py-4' />\n")).toEqual([1]);
  });

  it("passes a container marked padding-ok on its line, the line above or the call's line", () => {
    expect(leaksIn('// padding-ok: menu panel\nconst a = "p-1";\n')).toEqual([]);
    expect(leaksIn('const a = "p-1"; // padding-ok: menu panel\n')).toEqual([]);
    expect(leaksIn('// padding-ok: menu panel\nconst a = cn(\n  "flex",\n  "p-1",\n);\n')).toEqual(
      [],
    );
    expect(leaksIn('// padding-ok: menu panel\n\nconst a = "p-1";\n')).toEqual([3]);
    expect(
      leaksIn('<div>\n  {/* padding-ok: menu list */}\n  <div className="p-1" />\n</div>\n'),
    ).toEqual([]);
  });

  it("takes only a comment that gives a reason", () => {
    expect(leaksIn('// padding-ok\nconst a = "p-2";\n')).toEqual([2]);
    expect(leaksIn('// padding-ok:\nconst a = "p-2";\n')).toEqual([2]);
    expect(leaksIn('const note = "padding-ok: menu";\nconst a = "p-2";\n')).toEqual([2]);
    expect(leaksIn('<p>padding-ok: menu</p>\nconst a = "p-2";\n')).toEqual([2]);
  });

  it("exempts a cva() value beside it, and only the base from the call's line", () => {
    const source = [
      "// padding-ok: base panel",
      "const a = cva(",
      '  "p-1",',
      "  {",
      "    variants: {",
      "      size: {",
      '        default: "p-2", // padding-ok: frames a thumbnail',
      '        sm: "px-3 py-1",',
      '        lg: "px-4 py-4",',
      "      },",
      "    },",
      "  },",
      ");",
      "",
    ].join("\n");
    expect(leaksIn(source)).toEqual([9]);
  });

  it("ignores class names quoted in comments", () => {
    expect(leaksIn('// was `p-2`, now "px-2 py-1"\nconst a = "px-2 py-1";\n')).toEqual([]);
    expect(leaksIn('/* a stray ` */\nconst a = "p-2";\n')).toEqual([2]);
    expect(leaksIn('const url = "https://example.com"; const a = "p-2";\n')).toEqual([1]);
  });

  it("reads .ts and .tsx in the renderer, the design system and the site", () => {
    expect(equalPaddingLeaks("apps/server/src/a.tsx", 'const a = "p-2";\n')).toEqual([]);
    expect(equalPaddingLeaks("packages/contracts/src/a.ts", 'const a = "p-2";\n')).toEqual([]);
    expect(lines(equalPaddingLeaks("apps/web/src/a.tsx", 'const a = "p-2";\n'))).toEqual([1]);
    expect(lines(equalPaddingLeaks("apps/web/src/lib/a.ts", 'const a = "p-2";\n'))).toEqual([1]);
    expect(lines(equalPaddingLeaks("apps/site/src/a.tsx", 'const a = "p-2";\n'))).toEqual([1]);
  });
});

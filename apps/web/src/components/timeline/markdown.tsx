/**
 * Assistant text and plan bodies render through this one markdown component so
 * heading/code/list styling stays consistent between the timeline and cards.
 * Elements are mapped to styled tags rather than arbitrary-variant selectors.
 *
 * The text renders block by block (`markdown-blocks.ts`): each top-level
 * block is its own memoised `ReactMarkdown`, so while a message streams only
 * the block at its end parses again on each delta. The blocks render no
 * wrapper of their own — their elements are the body's direct children, as a
 * single parse would leave them — and while `streaming` each element the body
 * gains fades in (opacity only, and not under reduced motion; the list
 * measures row heights itself, so a height never animates).
 *
 * Fenced blocks render as a `CodeBlock` (header, copy, wrap, highlighting).
 * The body's `id` — the item it belongs to — keys each block by item and
 * offset in the whole text, so a row the list recycles for another item
 * neither keeps the old block's wrap state nor reuses its highlight. While
 * `streaming`, a block whose closing fence has not arrived stays plain, which
 * also keeps the highlighter from tokenizing it again on every delta.
 *
 * The `user` variant renders what a person typed in the user bubble: a single
 * line ending is a line break, raw HTML shows as the text it is
 * (`remark-user-text.ts`), headings stay at body size, and inline code sits on
 * a lighter chip that reads on the bubble's background.
 *
 * An agent's text names files: a link or an inline code span whose path the
 * thread's workspace confirms renders as a file chip (`markdown-paths.tsx`).
 * The URL filter lets a path with a line (`README.md:12`) and a `file://` URL
 * through to that check, since it would otherwise read them as schemes.
 *
 * While the find bar searches, a block holding its query parses again with
 * the query marked (`rehype-find-marks.ts`); every other block, and every
 * block while the bar is closed, keeps its memoised render.
 */

import * as React from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

import { CodeBlock } from "./code-block";
import { codeFenceInfo, type HastLike, hastText } from "./code-fence";
import { splitMarkdownBlocks } from "./markdown-blocks";
import { InlineCode, MarkdownLink } from "./markdown-paths";
import { PathChipsProvider } from "./path-chips";
import { collectPathCandidates, parsePathLink } from "./path-links";
import { rehypeFindMarks } from "./rehype-find-marks";
import { remarkHtmlAsText, remarkSoftBreaks } from "./remark-user-text";
import { hasMatch } from "./thread-find";
import { useFindHighlight } from "./thread-find-context";

interface BlockContext {
  readonly id: string | undefined;
  /** Where the block starts in the whole text: node offsets count from it. */
  readonly base: number;
  /** Where an unterminated fence opens in the block, while it streams. */
  readonly openFrom: number | undefined;
}

const MarkdownBlockContext = React.createContext<BlockContext>({
  id: undefined,
  base: 0,
  openFrom: undefined,
});

interface HastElementLike extends HastLike {
  readonly tagName?: string;
  readonly properties?: { readonly className?: unknown };
  readonly data?: unknown;
  readonly position?: { readonly start: { readonly offset?: number } };
}

/**
 * react-markdown passes no `inline` flag, and a fence without a language has
 * no class either, so a block is told apart here: `pre` reads its `code`
 * child off the hast node and renders the block itself, and the `code`
 * override only ever sees inline code.
 */
function FencedBlock({ node }: { readonly node: HastElementLike | undefined }) {
  const { id, base, openFrom } = React.useContext(MarkdownBlockContext);
  const code = node?.children?.find(
    (child): child is HastElementLike => (child as HastElementLike).tagName === "code",
  );
  const meta = (code?.data as { readonly meta?: unknown } | undefined)?.meta;
  const info = codeFenceInfo(
    code?.properties?.className,
    typeof meta === "string" ? meta : undefined,
  );
  // mdast-util-to-hast appends a newline to a fence's text; the source has none.
  const text = code === undefined ? "" : hastText(code).replace(/\n$/, "");
  const offset = node?.position?.start.offset ?? 0;
  const key = id === undefined ? undefined : `${id}:${base + offset}`;
  return (
    <CodeBlock
      key={key ?? base + offset}
      code={text}
      info={info}
      cacheKey={key === undefined ? undefined : `${key}:${text.length}`}
      plain={openFrom !== undefined && offset >= openFrom}
    />
  );
}

const components: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mt-5 mb-3 text-base font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-3 text-base font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="mb-3 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="mb-1">{children}</li>,
  a: ({ children, href }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-border pl-3 text-muted-foreground last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border px-2 py-1 align-bottom font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-border px-2 py-1 align-top">{children}</td>,
  pre: ({ node }) => <FencedBlock node={node} />,
  code: ({ children }) => (
    <InlineCode className="rounded-sm bg-hover px-1 py-0.5 font-mono text-xs">
      {children}
    </InlineCode>
  ),
};

const urlTransform = (url: string): string =>
  parsePathLink(url) === null ? defaultUrlTransform(url) : url;

// A heading someone typed stays a heading, at the size of the text around it.
const userHeading =
  (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
  ({ children }: { readonly children?: React.ReactNode }) => (
    <Tag className="mt-3 mb-2 text-sm font-semibold first:mt-0">{children}</Tag>
  );

const userComponents: typeof components = {
  ...components,
  h1: userHeading("h1"),
  h2: userHeading("h2"),
  h3: userHeading("h3"),
  h4: userHeading("h4"),
  h5: userHeading("h5"),
  h6: userHeading("h6"),
  code: ({ children }) => (
    <code className="rounded-sm bg-background/60 px-1 py-0.5 font-mono text-xs">{children}</code>
  ),
};

type MarkdownProps = React.ComponentProps<typeof ReactMarkdown>;

interface Variant {
  readonly remarkPlugins: MarkdownProps["remarkPlugins"];
  readonly components: MarkdownProps["components"];
  readonly className: string;
}

const VARIANTS: Readonly<Record<"agent" | "user", Variant>> = {
  agent: {
    remarkPlugins: [remarkGfm],
    components,
    className: "leading-prose",
  },
  user: {
    remarkPlugins: [remarkGfm, remarkHtmlAsText, remarkSoftBreaks],
    components: userComponents,
    className: "leading-normal",
  },
};

type VariantName = keyof typeof VARIANTS;

/** One top-level block, parsed on its own; it renders again only when its source does. */
const MarkdownBlock = React.memo(function MarkdownBlock({
  source,
  id,
  base,
  openFrom,
  variant,
  find,
}: {
  readonly source: string;
  readonly id: string | undefined;
  readonly base: number;
  readonly openFrom: number | undefined;
  readonly variant: VariantName;
  /** The find bar's query, only on a block that holds it. */
  readonly find: string | undefined;
}) {
  const context = React.useMemo(() => ({ id, base, openFrom }), [id, base, openFrom]);
  const config = VARIANTS[variant];
  const rehypePlugins = React.useMemo(
    () => (find === undefined ? undefined : [rehypeFindMarks(find)]),
    [find],
  );
  return (
    <MarkdownBlockContext.Provider value={context}>
      <ReactMarkdown
        remarkPlugins={config.remarkPlugins}
        components={config.components}
        rehypePlugins={rehypePlugins}
        urlTransform={urlTransform}
      >
        {source}
      </ReactMarkdown>
    </MarkdownBlockContext.Provider>
  );
});

export function MarkdownBody({
  text,
  id,
  streaming = false,
  variant = "agent",
  className,
}: {
  text: string;
  /** The item the text belongs to, which keys its code blocks. */
  id?: string;
  /** The text is still arriving: new elements fade in, an open fence stays plain. */
  streaming?: boolean;
  /** `user` for the text a person typed, `agent` (the default) for the rest. */
  variant?: VariantName;
  className?: string;
}) {
  const { blocks, definitions } = React.useMemo(() => splitMarkdownBlocks(text), [text]);
  const config = VARIANTS[variant];
  // Only a block holding the find bar's query parses again when the query changes.
  const findQuery = useFindHighlight()?.query;
  // Only an agent's text is asked about: what a person typed stays as typed.
  const candidates = React.useMemo(
    () => (variant === "agent" ? collectPathCandidates(text) : []),
    [variant, text],
  );
  return (
    <div
      className={cn(
        "text-sm text-foreground",
        config.className,
        streaming &&
          "motion-safe:*:transition-opacity motion-safe:*:duration-300 motion-safe:*:starting:opacity-0",
        className,
      )}
    >
      <PathChipsProvider candidates={candidates}>
        {blocks.map((block) => (
          <MarkdownBlock
            key={block.key}
            // A reference link resolves against definitions in any block; a
            // definition renders nothing, so they ride along at the end. An
            // open fence would swallow them as code.
            source={
              definitions !== "" && !block.open && block.source.includes("]")
                ? `${block.source}\n\n${definitions}`
                : block.source
            }
            id={id}
            base={block.start}
            openFrom={streaming ? block.openFrom : undefined}
            variant={variant}
            find={
              findQuery !== undefined && hasMatch(block.source, findQuery) ? findQuery : undefined
            }
          />
        ))}
      </PathChipsProvider>
    </div>
  );
}

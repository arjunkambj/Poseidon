/**
 * The Pull request tab's checks rendered statically: each bucket draws its
 * own glyph, and a failing check draws the cross (`Close`), never the X
 * brand logo that shares the letter's name.
 */

import { Check, Clock, Close, Minus, X } from "@honeyicons/react";
import type { PullRequestCheck } from "@poseidon/contracts/pullRequest";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PrChecks } from "./pr-checks";

const check = (bucket: PullRequestCheck["bucket"]): PullRequestCheck => ({
  name: `${bucket} job`,
  workflow: null,
  bucket,
  startedAt: null,
  completedAt: null,
  url: null,
  jobId: null,
});

// An icon's drawing, without the attributes a row adds to it.
const pathsOf = (markup: string): string => (markup.match(/<path[^>]*>/g) ?? []).join("");

const rowIcon = (bucket: PullRequestCheck["bucket"]): string =>
  pathsOf(renderToStaticMarkup(<PrChecks checks={[check(bucket)]} />));

describe("PrChecks", () => {
  it("draws the cross for a failing check, not the X brand logo", () => {
    const cross = pathsOf(renderToStaticMarkup(<Close variant="bold" />));
    const brand = pathsOf(renderToStaticMarkup(<X variant="bold" />));
    expect(cross).not.toBe(brand);
    expect(rowIcon("fail")).toBe(cross);
  });

  it("draws each other bucket's glyph", () => {
    expect(rowIcon("pending")).toBe(pathsOf(renderToStaticMarkup(<Clock variant="bold" />)));
    expect(rowIcon("pass")).toBe(pathsOf(renderToStaticMarkup(<Check variant="bold" />)));
    expect(rowIcon("skipped")).toBe(pathsOf(renderToStaticMarkup(<Minus variant="bold" />)));
  });

  it("labels the failing icon for screen readers", () => {
    expect(renderToStaticMarkup(<PrChecks checks={[check("fail")]} />)).toContain(
      'aria-label="Failing"',
    );
  });
});

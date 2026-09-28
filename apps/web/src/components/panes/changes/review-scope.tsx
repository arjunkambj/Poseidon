/**
 * Where the Changes pane's writes and on-demand reads act, for the files
 * under it: the project and thread (whose worktree the files are in), the
 * comparison's base a discard goes back to (`./discard`), and why discarding
 * cannot start right now.
 *
 * The thread's pane and the New task page's each provide one around their
 * list; without a provider (`null`) the file rows offer neither Discard nor
 * blame, since nothing says where they would run.
 */

import * as React from "react";

import type { ReviewScopeFields, ReviewWhere } from "./discard";

export interface ReviewScope extends ReviewWhere, ReviewScopeFields {
  /** Non-null disables Discard and says why: offline, or a turn or restore running. */
  readonly discardDisabledReason: string | null;
}

const ReviewScopeContext = React.createContext<ReviewScope | null>(null);

export function ReviewScopeProvider({
  value,
  children,
}: {
  value: ReviewScope;
  children: React.ReactNode;
}) {
  return <ReviewScopeContext.Provider value={value}>{children}</ReviewScopeContext.Provider>;
}

/** The scope the rows act in, or `null` outside a Changes pane. */
export const useReviewScope = (): ReviewScope | null => React.useContext(ReviewScopeContext);

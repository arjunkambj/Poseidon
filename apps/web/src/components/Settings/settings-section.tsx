/**
 * The one layout every Settings page shares: a page header, then sections —
 * a small title and optional description over a card whose rows put a title
 * and description on the left and a compact control on the right, with a
 * hairline between rows. A section can drop the card (`card={false}`) for
 * content that is its own surface: theme previews, lists of cards, prose.
 */

import * as React from "react";

import { Card, CardContent } from "@poseidon/ui/components/card";

/** The page's title, its one-line description, and optional actions on the right. */
export function SettingsPageHeader({
  title,
  description,
  actions,
}: {
  readonly title: string;
  readonly description?: React.ReactNode;
  readonly actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-medium">{title}</h1>
        {description === undefined ? null : (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/**
 * A titled group of settings. Direct children are the rows: inside the card
 * each one is separated from the next by a hairline. A titled section is a
 * region named by its title.
 */
export function SettingsSection({
  title,
  description,
  card = true,
  children,
}: {
  readonly title?: string;
  readonly description?: React.ReactNode;
  readonly card?: boolean;
  readonly children?: React.ReactNode;
}) {
  const titleId = React.useId();
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby={title === undefined ? undefined : titleId}
    >
      {title === undefined && description === undefined ? null : (
        <div>
          {title === undefined ? null : (
            <h2 id={titleId} className="text-sm font-medium">
              {title}
            </h2>
          )}
          {description === undefined ? null : (
            <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>
          )}
        </div>
      )}
      {card ? (
        <Card size="sm">
          <CardContent>
            <div className="flex flex-col divide-y">{children}</div>
          </CardContent>
        </Card>
      ) : (
        children
      )}
    </section>
  );
}

/**
 * One setting: its title and description on the left, its control on the
 * right. With `htmlFor` the title is the control's `<label>`.
 */
export function SettingsRow({
  title,
  description,
  htmlFor,
  children,
}: {
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  readonly htmlFor?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div className="min-w-0">
        {htmlFor === undefined ? (
          <div className="text-sm font-medium">{title}</div>
        ) : (
          <label htmlFor={htmlFor} className="block text-sm font-medium">
            {title}
          </label>
        )}
        {description === undefined ? null : (
          <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

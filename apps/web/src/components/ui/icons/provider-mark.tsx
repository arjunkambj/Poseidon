/**
 * A model's provider mark, drawn before its name in a row whose harness spans
 * providers (`spansProviders`): monochrome and bold like any icon beside text
 * (bold is also Meta's official mark). A provider Honeyicons has no logo for
 * gets an empty box the same size, so the names stay aligned; no generic glyph
 * stands in for a logo. It is decorative: the model's name and id say who
 * makes it.
 */

import { providerMarkFor } from "./brand-icons";

export function ProviderMark({ providerKey }: { readonly providerKey: string }) {
  const Mark = providerMarkFor(providerKey);
  return Mark === undefined ? (
    <span aria-hidden data-slot="provider-mark" className="size-3.5 shrink-0" />
  ) : (
    <Mark
      variant="bold"
      aria-hidden
      data-slot="provider-mark"
      className="size-3.5 shrink-0 text-foreground/85"
    />
  );
}

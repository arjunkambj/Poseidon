/**
 * A harness drawn as a small round avatar: its colour logo when the
 * connector's `iconKey` names one (`harnessLogoFor`), else the monogram
 * `harnessMonograms` gives the instance's name, so a harness Honeyicons has
 * no logo for (or a key this build does not know) still reads apart from the
 * others. It is decorative: the name is always said beside it or in its
 * tooltip.
 */

import { Avatar, AvatarFallback } from "@poseidon/ui/components/avatar";

import { harnessLogoFor } from "@/components/ui/icons/brand-icons";

export function HarnessAvatar({
  monogram,
  iconKey,
  size = "sm",
  className,
}: {
  readonly monogram: string;
  /** The connector's `metadata.iconKey`; absent while the descriptors load. */
  readonly iconKey?: string | undefined;
  readonly size?: "sm" | "default";
  readonly className?: string;
}) {
  const Logo = harnessLogoFor(iconKey);
  return (
    <Avatar size={size} aria-hidden className={className}>
      <AvatarFallback>
        {Logo === undefined ? monogram : <Logo aria-hidden className="size-4" />}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * A harness drawn as a small round avatar: the monogram `harnessMonograms`
 * gives the instance's name. It is decorative: the name is always said beside
 * it or in its tooltip.
 */

import { Avatar, AvatarFallback } from "@poseidon/ui/components/avatar";

export function HarnessAvatar({
  monogram,
  size = "sm",
  className,
}: {
  readonly monogram: string;
  readonly size?: "sm" | "default";
  readonly className?: string;
}) {
  return (
    <Avatar size={size} aria-hidden className={className}>
      <AvatarFallback>{monogram}</AvatarFallback>
    </Avatar>
  );
}

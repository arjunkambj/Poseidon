/**
 * One section per connector instance that manages a kind. Skills and MCP
 * servers belong to each harness's own files, so a tab lists them instance by
 * instance, under the instance's name and its logo or generic icon, rather
 * than merging lists that different harnesses load differently.
 */

import { useAtomValue } from "@effect/atom-react";
import type { ConnectorSummary } from "@poseidon/contracts/connectors";
import type * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { connectorIconFor } from "@/components/ui/icons/brand-icons";
import { useConnectorIconKeys } from "@/components/ui/icons/use-connector-icon-keys";
import { useAppAtoms } from "@/lib/app-runtime";
import { instancesWith, type InstanceExtension } from "@/lib/customize-instances";

import { CustomizeEmpty } from "./customize-list";

export function CustomizeInstances({
  kind,
  empty,
  actions,
  children,
}: {
  readonly kind: InstanceExtension;
  /** Shown when no enabled instance manages this kind. */
  readonly empty: React.ReactNode;
  /** Buttons on the instance's heading row, e.g. "Add server". */
  readonly actions?: (instance: ConnectorSummary) => React.ReactNode;
  readonly children: (instance: ConnectorSummary) => React.ReactNode;
}) {
  const atoms = useAppAtoms();
  const connectorsResult = useAtomValue(atoms.connectorsAtom);

  if (!AsyncResult.isSuccess(connectorsResult)) {
    return <CustomizeEmpty>Loading…</CustomizeEmpty>;
  }
  const instances = instancesWith(connectorsResult.value, kind);
  if (instances.length === 0) {
    return <CustomizeEmpty>{empty}</CustomizeEmpty>;
  }

  return instances.map((instance) => (
    <InstanceSection
      key={instance.connectorInstanceId}
      instance={instance}
      actions={actions?.(instance)}
    >
      {children(instance)}
    </InstanceSection>
  ));
}

/**
 * One instance's section: its heading, under the instance's name and its
 * logo or generic icon, then whatever it lists. A tab that hides an instance
 * with nothing to show renders this itself, only once it knows there is
 * something.
 */
export function InstanceSection({
  instance,
  actions,
  children,
}: {
  readonly instance: ConnectorSummary;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  const Icon = connectorIconFor(useConnectorIconKeys().get(instance.kind));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-2 text-base font-medium">
          <Icon variant="bold" className="size-4 shrink-0 text-foreground/85" />
          <span className="truncate">{instance.displayName}</span>
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * One section per connector instance that manages a kind. Skills and MCP
 * servers belong to each harness's own files, so a tab lists them instance by
 * instance, under the instance's name and generic icon, rather than merging
 * lists that different harnesses load differently.
 */

import { useAtomValue } from "@effect/atom-react";
import type { ConnectorSummary } from "@poseidon/contracts/connectors";
import type * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { useAppAtoms } from "@/lib/app-runtime";
import { connectorIconFor } from "@/lib/connector-icon";
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
  const descriptorsResult = useAtomValue(atoms.connectorDescriptorsAtom);

  if (!AsyncResult.isSuccess(connectorsResult)) {
    return <CustomizeEmpty>Loading…</CustomizeEmpty>;
  }
  const instances = instancesWith(connectorsResult.value, kind);
  if (instances.length === 0) {
    return <CustomizeEmpty>{empty}</CustomizeEmpty>;
  }
  const descriptors = AsyncResult.isSuccess(descriptorsResult) ? descriptorsResult.value : [];

  return instances.map((instance) => {
    const Icon = connectorIconFor(
      descriptors.find((descriptor) => descriptor.kind === instance.kind)?.metadata.iconKey,
    );
    return (
      <section key={instance.connectorInstanceId} className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-2 text-base font-medium">
            <Icon variant="bold" className="size-4 shrink-0 text-foreground/85" />
            <span className="truncate">{instance.displayName}</span>
          </h2>
          {actions?.(instance)}
        </div>
        {children(instance)}
      </section>
    );
  });
}

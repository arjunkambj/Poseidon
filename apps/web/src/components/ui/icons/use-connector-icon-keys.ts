/**
 * Each connector kind's `metadata.iconKey`, from the descriptors the server
 * lists, so a pure helper can take the map instead of reading atoms. Empty
 * until the descriptors load; a kind missing from it draws its fallback.
 */

import { useAtomValue } from "@effect/atom-react";
import * as React from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { useAppAtoms } from "@/lib/app-runtime";

export const useConnectorIconKeys = (): ReadonlyMap<string, string> => {
  const atoms = useAppAtoms();
  const descriptorsResult = useAtomValue(atoms.connectorDescriptorsAtom);
  return React.useMemo(
    () =>
      new Map(
        AsyncResult.isSuccess(descriptorsResult)
          ? descriptorsResult.value.map((descriptor) => [
              descriptor.kind,
              descriptor.metadata.iconKey,
            ])
          : [],
      ),
    [descriptorsResult],
  );
};

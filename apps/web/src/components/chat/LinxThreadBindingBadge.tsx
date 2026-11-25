import { AuthOrchestrationReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { linxExpertDefinitions, linxThreadBinding } from "../../state/linx";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";

export function LinxThreadBindingBadge({
  threadRef: { environmentId, threadId },
}: {
  readonly threadRef: ScopedThreadRef;
}) {
  const gt = useGT();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const query = useEnvironmentQuery(
    canRead ? linxThreadBinding({ environmentId, input: { threadId } }) : null,
  );
  const definitions = useEnvironmentQuery(
    canRead ? linxExpertDefinitions({ environmentId, input: {} }) : null,
  );
  if (!canRead) return null;
  const binding = query.data;
  const title =
    binding === null
      ? undefined
      : definitions.data?.find((entry) => entry.expertId === binding.expertId)?.title;
  const label = binding
    ? gt("{expert} · v{revision} · {hash}", {
        expert: title ?? binding.expertId,
        revision: binding.revision,
        hash: binding.contentHash.slice(0, 8),
      })
    : null;
  return (
    <span
      className="inline-flex h-5 w-32 shrink-0 items-center sm:w-48"
      aria-live="polite"
      data-linx-binding-slot
    >
      {binding && label ? (
        <Badge
          className="max-w-full"
          variant="info"
          size="sm"
          title={gt("Frozen Expert snapshot: {label}", { label })}
        >
          <span className="truncate">{label}</span>
        </Badge>
      ) : query.isPending ? (
        <span className="sr-only">{gt("Loading Expert binding…")}</span>
      ) : query.error ? (
        <span className="sr-only">{gt("Expert binding could not be read.")}</span>
      ) : null}
    </span>
  );
}

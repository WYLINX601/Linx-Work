import { AuthOrchestrationReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { cn } from "../../lib/utils";
import { linxExpertDefinitions, linxThreadBinding } from "../../state/linx";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";

export function LinxThreadBindingBadge({
  threadRef: { environmentId, threadId },
  className,
  memberDetail = false,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly className?: string;
  readonly memberDetail?: boolean;
}) {
  const gt = useGT();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const query = useEnvironmentQuery(
    canRead ? linxThreadBinding({ environmentId, input: { threadId } }) : null,
  );
  const binding = query.data;
  const suite = binding?.suite;
  const definitions = useEnvironmentQuery(
    canRead && !memberDetail && binding !== null && suite === undefined && !binding.expertTitle
      ? linxExpertDefinitions({ environmentId, input: {} })
      : null,
  );
  if (!canRead) return null;
  const expertTitle =
    binding?.expertTitle ??
    definitions.data?.find((entry) => entry.expertId === binding?.expertId)?.title;
  const expertLabel = binding
    ? gt("{expert} · v{revision} · {hash}", {
        expert: expertTitle ?? binding.expertId,
        revision: binding.revision,
        hash: binding.contentHash.slice(0, 8),
      })
    : null;
  const frozenExpert = expertLabel
    ? gt("Frozen Expert snapshot: {label}", { label: expertLabel })
    : null;
  if (memberDetail) {
    return suite?.role === "member" && frozenExpert ? (
      <Badge className={cn("max-w-full", className)} variant="info" size="sm" title={frozenExpert}>
        <span className="truncate">{frozenExpert}</span>
      </Badge>
    ) : null;
  }
  const suiteLabel = suite
    ? gt("Suite v{revision} · {role}", {
        revision: suite.revision,
        role: suite.role === "lead" ? gt("Lead") : gt("Member"),
      })
    : null;
  return (
    <span
      className="inline-flex h-5 w-32 shrink-0 items-center sm:w-48"
      aria-live="polite"
      data-linx-binding-slot
    >
      {suite && suiteLabel ? (
        <Badge
          className="max-w-full"
          variant="info"
          size="sm"
          title={[suiteLabel, suite.name, suite.memberTitle, frozenExpert]
            .filter(Boolean)
            .join(" · ")}
        >
          <span className="shrink-0">{suiteLabel}</span>
          <span className="truncate">{suite.name}</span>
        </Badge>
      ) : expertLabel && frozenExpert ? (
        <Badge className="max-w-full" variant="info" size="sm" title={frozenExpert}>
          <span className="truncate">{expertLabel}</span>
        </Badge>
      ) : query.isPending ? (
        <span className="sr-only">{gt("Loading Expert binding…")}</span>
      ) : query.error ? (
        <span className="sr-only">{gt("Expert binding could not be read.")}</span>
      ) : null}
    </span>
  );
}

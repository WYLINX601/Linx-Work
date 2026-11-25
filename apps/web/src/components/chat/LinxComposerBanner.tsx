import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { UserRoundIcon } from "lucide-react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { linxExperts } from "../../state/linx";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import { ComposerBannerStack } from "./ComposerBannerStack";

export function LinxComposerBanner({
  environmentId,
  draftTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly draftTarget: ComposerThreadTarget;
}) {
  const gt = useGT();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const experts = useEnvironmentQuery(
    canOperate ? linxExperts({ environmentId, input: {} }) : null,
  );
  const choice = useComposerDraftStore((store) => store.getComposerDraft(draftTarget)?.linxLaunch);
  if (!canOperate) return null;

  const selected = choice?.environmentId === environmentId ? choice.expert : undefined;
  const options = experts.data ?? [];
  const noExpert = gt("No Expert");
  const description = selected
    ? gt("Attachments are unavailable when starting an Expert thread.")
    : experts.isPending
      ? gt("Loading Experts…")
      : experts.error
        ? gt("Experts could not be loaded.")
        : options.length === 0
          ? gt("No Expert snapshots yet. You can still start a regular thread.")
          : gt("Choose an immutable Expert snapshot for the first turn.");

  return (
    <ComposerBannerStack
      detached
      items={[
        {
          id: "linx-expert",
          variant: "default",
          icon: <UserRoundIcon aria-hidden />,
          title: gt("Expert"),
          description,
          actions:
            options.length > 0 || selected ? (
              <Select
                modal={false}
                value={selected?.snapshotId ?? ""}
                onValueChange={(snapshotId) => {
                  const next = options.find((expert) => expert.snapshotId === snapshotId);
                  if (snapshotId === selected?.snapshotId) return;
                  const store = useComposerDraftStore.getState();
                  if (next === undefined) {
                    store.setLinxLaunch(draftTarget, null);
                  } else {
                    const { personaPreview: _preview, ...expert } = next;
                    store.setLinxLaunch(draftTarget, { environmentId, expert, attempt: null });
                  }
                }}
              >
                <SelectTrigger size="xs" variant="ghost" aria-label={gt("Choose Expert")}>
                  {selected
                    ? gt("{expert} · v{revision} · {hash}", {
                        expert: selected.expertId,
                        revision: selected.revision,
                        hash: selected.contentHash.slice(0, 8),
                      })
                    : noExpert}
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value="">{noExpert}</SelectItem>
                  {selected &&
                  !options.some((expert) => expert.snapshotId === selected.snapshotId) ? (
                    <SelectItem value={selected.snapshotId}>
                      {gt("{expert} · v{revision} · {hash}", {
                        expert: selected.expertId,
                        revision: selected.revision,
                        hash: selected.contentHash.slice(0, 8),
                      })}
                    </SelectItem>
                  ) : null}
                  {options.map((expert) => (
                    <SelectItem
                      key={expert.snapshotId}
                      value={expert.snapshotId}
                      title={expert.personaPreview}
                    >
                      {gt("{expert} · v{revision} · {hash}", {
                        expert: expert.expertId,
                        revision: expert.revision,
                        hash: expert.contentHash.slice(0, 8),
                      })}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null,
        },
      ]}
    />
  );
}

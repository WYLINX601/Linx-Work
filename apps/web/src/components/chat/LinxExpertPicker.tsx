import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type LinxExpertSummary,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { linxExperts } from "../../state/linx";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

export function LinxExpertPicker({
  environmentId,
  draftTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly draftTarget: ComposerThreadTarget;
}) {
  const gt = useGT();
  const composerMenuProps = useComposerMenuProps();
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
    ? undefined
    : experts.isPending
      ? gt("Loading Experts…")
      : experts.error
        ? gt("Experts could not be loaded.")
        : options.length === 0
          ? gt("No Expert snapshots yet. You can still start a regular thread.")
          : gt("Choose an immutable Expert snapshot for the first turn.");
  const snapshotLabel = ({
    expertId,
    title,
    revision,
    contentHash,
  }: Pick<LinxExpertSummary, "expertId" | "title" | "revision" | "contentHash">) =>
    gt("{expert} · v{revision} · {hash}", {
      expert: title.length > 0 ? title : expertId,
      revision,
      hash: contentHash.slice(0, 8),
    });

  return (
    <Menu modal={false}>
      <MenuTrigger
        render={
          <ComposerControl
            aria-label={gt("Choose Expert")}
            aria-description={description}
            title={selected ? snapshotLabel(selected) : description}
            data-chat-expert-picker
            className="min-w-0 max-w-28 data-popup-open:bg-accent data-popup-open:text-foreground sm:max-w-40"
          />
        }
      >
        <span data-composer-control-label className="truncate">
          {selected?.title ?? noExpert}
        </span>
        <ChevronDownIcon
          aria-hidden
          data-composer-control-chevron
          className="size-3.5 opacity-70"
        />
      </MenuTrigger>
      <MenuPopup
        side="top"
        align="end"
        width="content"
        className="sm:max-w-xs"
        {...composerMenuProps}
      >
        <MenuGroup aria-label={gt("Expert")}>
          {description ? <MenuGroupLabel>{description}</MenuGroupLabel> : null}
          <MenuRadioGroup
            value={selected?.snapshotId ?? ""}
            onValueChange={(snapshotId: string) => {
              if (snapshotId === selected?.snapshotId) return;
              const next = options.find((expert) => expert.snapshotId === snapshotId);
              const store = useComposerDraftStore.getState();
              if (next === undefined) {
                store.setLinxLaunch(draftTarget, null);
              } else {
                const { personaPreview: _preview, ...expert } = next;
                store.setLinxLaunch(draftTarget, { environmentId, expert, attempt: null });
                store.setLinxSuiteLaunch(draftTarget, null);
              }
            }}
          >
            <MenuRadioItem value="" closeOnClick>
              {noExpert}
            </MenuRadioItem>
            {selected && !options.some((expert) => expert.snapshotId === selected.snapshotId) ? (
              <MenuRadioItem value={selected.snapshotId} closeOnClick>
                {snapshotLabel(selected)}
              </MenuRadioItem>
            ) : null}
            {options.map((expert) => (
              <MenuRadioItem
                key={expert.snapshotId}
                value={expert.snapshotId}
                title={expert.personaPreview}
                closeOnClick
              >
                {snapshotLabel(expert)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

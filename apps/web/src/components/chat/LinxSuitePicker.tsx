import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type LinxSuiteSummary,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { linxSuites } from "../../state/linx";
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

export function LinxSuitePicker({
  environmentId,
  draftTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly draftTarget: ComposerThreadTarget;
}) {
  const gt = useGT();
  const composerMenuProps = useComposerMenuProps();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const suites = useEnvironmentQuery(canOperate ? linxSuites({ environmentId, input: {} }) : null);
  const choice = useComposerDraftStore(
    (store) => store.getComposerDraft(draftTarget)?.linxSuiteLaunch,
  );
  if (!canOperate) return null;

  const selected = choice?.environmentId === environmentId ? choice.suite : undefined;
  const options = (suites.data ?? []).filter((suite) => !suite.archived);
  const description = selected
    ? undefined
    : suites.isPending
      ? gt("Loading suites…")
      : suites.error
        ? gt("Suites could not be loaded.")
        : options.length === 0
          ? gt("No suites yet. Create one in Settings → Linx experts.")
          : gt("Choose an immutable Suite snapshot for the first turn.");
  const label = (suite: LinxSuiteSummary) =>
    gt("{suite} · v{revision} · {members} members", {
      suite: suite.name,
      revision: suite.currentRevision,
      members: suite.memberCount,
    });

  return (
    <Menu modal={false}>
      <MenuTrigger
        render={
          <ComposerControl
            aria-label={gt("Choose Suite")}
            aria-description={description}
            title={selected ? label(selected) : description}
            data-chat-suite-picker
            className="min-w-0 max-w-28 data-popup-open:bg-accent data-popup-open:text-foreground sm:max-w-40"
          />
        }
      >
        <span data-composer-control-label className="truncate">
          {selected?.name ?? gt("No Suite")}
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
        <MenuGroup aria-label={gt("Suite")}>
          {description ? <MenuGroupLabel>{description}</MenuGroupLabel> : null}
          <MenuRadioGroup
            value={selected?.suiteId ?? ""}
            onValueChange={(suiteId: string) => {
              if (suiteId === selected?.suiteId) return;
              const next = options.find((suite) => suite.suiteId === suiteId);
              const store = useComposerDraftStore.getState();
              if (next === undefined) {
                store.setLinxSuiteLaunch(draftTarget, null);
              } else {
                store.setLinxSuiteLaunch(draftTarget, {
                  environmentId,
                  suite: next,
                  attempt: null,
                });
                store.setLinxLaunch(draftTarget, null);
              }
            }}
          >
            <MenuRadioItem value="" closeOnClick>
              {gt("No Suite")}
            </MenuRadioItem>
            {selected && !options.some((suite) => suite.suiteId === selected.suiteId) ? (
              <MenuRadioItem value={selected.suiteId} closeOnClick>
                {label(selected)}
              </MenuRadioItem>
            ) : null}
            {options.map((suite) => (
              <MenuRadioItem key={suite.suiteId} value={suite.suiteId} closeOnClick>
                {label(suite)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

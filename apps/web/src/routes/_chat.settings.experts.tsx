import { createFileRoute } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { LinxExpertsSettings } from "../components/settings/LinxExpertsSettings";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function SettingsExpertsRoute() {
  const { environment, scope } = useSettingsScope();
  const gt = useGT();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? gt("Reconnect {label} to manage its Linx experts.", { label: scope.label })
          : gt("Connect an environment to manage Linx experts.")}
      </p>
    );
  }
  return <LinxExpertsSettings environmentId={environment.environmentId} />;
}

export const Route = createFileRoute("/_chat/settings/experts")({
  component: SettingsExpertsRoute,
});

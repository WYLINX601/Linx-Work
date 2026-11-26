import {
  EnvironmentId,
  ProviderInstanceId,
  type LinxExpertDefinitionSummary,
  type LinxSuiteDetail,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { LinxSuiteSettings } from "./LinxSuiteSettings";

const fixture = vi.hoisted(() => ({
  listQuery: Symbol(),
  detailQuery: Symbol(),
  detail: null as LinxSuiteDetail | null,
  save: vi.fn(),
}));
vi.mock(import("../../state/linx"), async (original) => ({
  ...(await original()),
  linxSuites: (() => fixture.listQuery) as never,
  linxSuiteDetail: (() => fixture.detailQuery) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((query: unknown) => ({
    isPending: false,
    data:
      query === fixture.listQuery
        ? fixture.detail === null
          ? []
          : [fixture.detail]
        : query === fixture.detailQuery
          ? fixture.detail
          : null,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => fixture.save) as never,
}));

const environmentId = EnvironmentId.make("environment");
const updatedAt = "2026-11-25T00:00:00.000Z";
const experts: ReadonlyArray<LinxExpertDefinitionSummary> = [
  { expertId: "lead", title: "Lead Expert", currentRevision: 3, snapshotId: "lead-3" },
  { expertId: "reviewer", title: "Reviewer", currentRevision: 4, snapshotId: "reviewer-4" },
].map((expert) => ({ ...expert, updatedAt, archived: false, contentHash: "a".repeat(64) }));
const member = {
  expertId: "reviewer",
  memberKey: "code-review",
  revision: 2,
  title: "Code review",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
};
const legacySuite: LinxSuiteDetail = {
  suiteId: "review",
  name: "Review team",
  currentRevision: 5,
  leadExpertId: "lead",
  leadExpertRevision: 1,
  leadSnapshotId: "lead-1",
  archived: false,
  updatedAt,
  memberCount: 1,
  members: [{ ...member, snapshotId: "reviewer-2" }],
  policy: { maxActiveDelegations: 2 },
};

function setup(detail: LinxSuiteDetail) {
  fixture.detail = detail;
  fixture.save.mockReset().mockResolvedValue({ _tag: "Success" });
  return render(<LinxSuiteSettings environmentId={environmentId} experts={experts} />);
}

it("defaults legacy policy safely and preserves pinned references when saving workspace write", async () => {
  await using screen = await setup(legacySuite);
  await screen.getByRole("button", { name: "Edit", exact: true }).click();
  const sandbox = screen.getByRole("combobox", { name: "Sandbox" });
  const isolation = screen.getByRole("combobox", { name: "Workspace isolation" });
  const approval = screen.getByRole("combobox", { name: "Approval" });
  await expect.element(sandbox).toHaveTextContent("Read-only");
  await expect.element(isolation).toHaveTextContent("Shared");
  await expect.element(approval).toHaveTextContent("Never");
  await expect.element(approval).toBeEnabled();

  await sandbox.click();
  await page.getByRole("option", { name: "Workspace write" }).click();
  await expect.element(isolation).toHaveTextContent("Worktree");
  await expect.element(isolation).toBeDisabled();
  await approval.click();
  await page.getByRole("option", { name: "On request" }).click();
  await screen.getByRole("button", { name: "Save revision" }).click();

  expect(fixture.save).toHaveBeenCalledWith({
    environmentId,
    input: {
      suiteId: legacySuite.suiteId,
      expectedRevision: legacySuite.currentRevision,
      name: legacySuite.name,
      leadExpertId: legacySuite.leadExpertId,
      leadExpertRevision: legacySuite.leadExpertRevision,
      members: [member],
      policy: {
        maxActiveDelegations: 2,
        sandbox: "workspace-write",
        workspaceIsolation: "worktree",
        approval: "on-request",
      },
    },
  });
});

it("preserves approvals across sandbox changes and upgrades only the selected Expert", async () => {
  await using screen = await setup({
    ...legacySuite,
    policy: {
      maxActiveDelegations: 2,
      sandbox: "workspace-write",
      workspaceIsolation: "worktree",
      approval: "on-request",
    },
  });
  await screen.getByRole("button", { name: "Edit", exact: true }).click();
  const sandbox = screen.getByRole("combobox", { name: "Sandbox" });
  const isolation = screen.getByRole("combobox", { name: "Workspace isolation" });
  const approval = screen.getByRole("combobox", { name: "Approval" });
  await expect.element(approval).toHaveTextContent("On request");
  await sandbox.click();
  await page.getByRole("option", { name: "Read-only" }).click();
  await expect.element(approval).toHaveTextContent("On request");
  await expect.element(approval).toBeEnabled();
  await isolation.click();
  await page.getByRole("option", { name: "Shared" }).click();
  await screen.getByRole("button", { name: "Use version 4 of Reviewer" }).click();
  const saveButton = screen.getByRole("button", { name: "Save revision" });
  await expect.element(saveButton).toBeEnabled();
  (saveButton.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");

  expect(fixture.save).toHaveBeenCalledWith({
    environmentId,
    input: {
      suiteId: legacySuite.suiteId,
      expectedRevision: legacySuite.currentRevision,
      name: legacySuite.name,
      leadExpertId: legacySuite.leadExpertId,
      leadExpertRevision: legacySuite.leadExpertRevision,
      members: [{ ...member, revision: 4 }],
      policy: {
        maxActiveDelegations: 2,
        sandbox: "read-only",
        workspaceIsolation: "shared",
        approval: "on-request",
      },
    },
  });
});

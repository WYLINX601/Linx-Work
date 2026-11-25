import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import {
  DraftId,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { LinxComposerBanner } from "./LinxComposerBanner";

const fixture = vi.hoisted(() => ({ canOperate: true, hasExpert: true }));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => fixture.canOperate,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: fixture.hasExpert
      ? [
          {
            expertId: "reviewer",
            snapshotId: "snap-fixed",
            revision: 12,
            contentHash: "a".repeat(64),
            personaPreview: "Review carefully",
          },
        ]
      : [],
    isPending: false,
    error: null,
  })) as never,
}));

const environmentId = EnvironmentId.make("linx-browser-test");

it("pins a revision to the current draft, not another draft or persisted settings", async () => {
  fixture.canOperate = true;
  fixture.hasExpert = true;
  const draftTarget = DraftId.make("linx-selected-draft");
  const otherDraft = DraftId.make("linx-other-draft");
  const store = useComposerDraftStore.getState();
  store.setPrompt(draftTarget, "Review this");
  await using screen = await render(
    <LinxComposerBanner environmentId={environmentId} draftTarget={draftTarget} />,
  );
  try {
    await screen.getByRole("combobox", { name: "Choose Expert" }).click();
    await page.getByRole("option", { name: "reviewer · v12 · aaaaaaaa" }).click();
    await expect
      .element(screen.getByRole("combobox", { name: "Choose Expert" }))
      .toHaveTextContent("reviewer · v12 · aaaaaaaa");
    expect(
      useComposerDraftStore.getState().getComposerDraft(draftTarget)?.linxLaunch?.expert.snapshotId,
    ).toBe("snap-fixed");
    expect(
      JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
    ).not.toContain("snap-fixed");
    await screen.rerender(
      <LinxComposerBanner environmentId={environmentId} draftTarget={otherDraft} />,
    );
    await expect
      .element(screen.getByRole("combobox", { name: "Choose Expert" }))
      .toHaveTextContent("No Expert");
  } finally {
    store.clearDraftThread(draftTarget);
  }
});

it("does not offer Expert selection to read-only sessions or require one when there are none", async () => {
  const draftTarget = DraftId.make("linx-empty-draft");
  fixture.canOperate = false;
  await using screen = await render(
    <LinxComposerBanner environmentId={environmentId} draftTarget={draftTarget} />,
  );
  await expect.element(screen.getByText("Expert", { exact: true })).not.toBeInTheDocument();
  fixture.canOperate = true;
  fixture.hasExpert = false;
  await screen.rerender(
    <LinxComposerBanner environmentId={environmentId} draftTarget={draftTarget} />,
  );
  await expect
    .element(screen.getByText("No Expert snapshots yet. You can still start a regular thread."))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("combobox", { name: "Choose Expert" }))
    .not.toBeInTheDocument();
});

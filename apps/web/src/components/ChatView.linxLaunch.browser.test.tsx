import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  WS_METHODS,
  type LinxLaunchThreadInput,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import "~/index.css";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerRpc,
  installFakeEnvironment,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

it("keeps the Expert launch request on retry and returns to native launch when deselected", async () => {
  await page.viewport(1280, 800);
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-linx-launch");
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
    threadId: ThreadId.make("reserved-linx-draft"),
  });
  using _draft = { [Symbol.dispose]: () => store.clearDraftThread(draftId) };
  using _experts = answerRpc(WS_METHODS.linxExpertsList, () =>
    Effect.succeed([
      {
        expertId: "reviewer",
        snapshotId: "snap-frozen-reviewer",
        revision: 3,
        contentHash: "a".repeat(64),
        personaPreview: "Review",
      },
    ]),
  );
  const expertCalls: LinxLaunchThreadInput[] = [];
  using _expertLaunch = answerRpc(WS_METHODS.linxThreadsLaunch, (input: LinxLaunchThreadInput) => {
    expertCalls.push(input);
    return Effect.fail({ code: "launch_failed", message: "Expert launcher is unavailable." });
  });
  const nativeLaunch = vi.fn(() => Effect.never);
  using _nativeLaunch = answerRpc(ORCHESTRATION_V2_WS_METHODS.launchThread, nativeLaunch);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const picker = page.getByRole("button", { name: "Choose Expert" });
  const editor = page.getByTestId("composer-editor");
  const attach = page.getByRole("button", { name: "Attach files" });
  await expect.element(attach).toBeVisible();
  await expect.element(picker).toBeVisible();
  const expertButton = picker.element();
  const modelButton = expertButton
    .closest("[data-chat-composer-footer]")
    ?.querySelector("[data-chat-provider-model-picker]");
  if (!modelButton) throw new Error("The Expert and model pickers must share the Composer footer.");
  expect(modelButton.getBoundingClientRect().width).toBeGreaterThan(0);

  expect(expertButton.getBoundingClientRect().right).toBeLessThanOrEqual(
    modelButton.getBoundingClientRect().left,
  );
  expect(
    Math.abs(expertButton.getBoundingClientRect().top - modelButton.getBoundingClientRect().top),
  ).toBeLessThan(4);
  await picker.click();
  await page.getByRole("menuitemradio", { name: "reviewer · v3 · aaaaaaaa" }).click();
  await expect.element(picker).toHaveTextContent("reviewer");
  await expect
    .element(picker)
    .toHaveAttribute(
      "aria-description",
      "Attachments are unavailable when starting an Expert thread.",
    );
  await expect.element(attach).not.toBeInTheDocument();
  await userEvent.click(editor);
  await cdp().send("Input.insertText", { text: "Review the frozen input" });
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Expert launcher is unavailable.")).toBeVisible();
  expect(expertCalls).toHaveLength(1);
  expect(expertCalls[0]).toMatchObject({
    clientRequestId: expect.any(String),
    projectId: PROJECT_ID,
    snapshotId: "snap-frozen-reviewer",
    initialMessage: { text: "Review the frozen input" },
  });
  await expect.element(editor).toHaveTextContent("Review the frozen input");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(expertCalls).toHaveLength(2));
  expect(expertCalls[1]).toEqual(expertCalls[0]);
  expect(nativeLaunch).not.toHaveBeenCalled();
  await picker.click();
  await page.getByRole("menuitemradio", { name: "No Expert" }).click();
  await expect.element(attach).toBeVisible();
  await userEvent.click(editor);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(nativeLaunch).toHaveBeenCalledOnce());
  expect(expertCalls).toHaveLength(2);
});

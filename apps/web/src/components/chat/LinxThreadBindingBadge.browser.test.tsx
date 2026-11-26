import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { LinxThreadBindingBadge } from "./LinxThreadBindingBadge";

const fixture = vi.hoisted(() => ({
  state: "loading",
  suiteRole: "lead" as "lead" | "member",
  expertDefinitionsQuery: {},
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("../../state/linx"), async (original) => ({
  ...(await original()),
  linxExpertDefinitions: (() => fixture.expertDefinitionsQuery) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((query: unknown) => ({
    isPending: query !== null && fixture.state === "loading",
    error: query !== null && fixture.state === "error" ? "failed" : null,
    data:
      query === fixture.expertDefinitionsQuery
        ? []
        : query !== null && fixture.state === "bound"
          ? { expertId: "reviewer", revision: 12, contentHash: "b".repeat(64) }
          : query !== null && fixture.state === "suite"
            ? {
                expertId: "reviewer",
                expertTitle: "Frozen Reviewer",
                revision: 12,
                contentHash: "b".repeat(64),
                suite: { name: "Review team", revision: 5, role: fixture.suiteRole },
              }
            : null,
  })) as never,
}));

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

it("keeps one header slot through loading, bound, unbound, and error states", async () => {
  fixture.state = "loading";
  await using screen = await render(<LinxThreadBindingBadge threadRef={threadRef} />);
  const slot = screen.container.querySelector("[data-linx-binding-slot]")!;
  const width = slot.getBoundingClientRect().width;
  await expect.element(screen.getByText("Loading Expert binding…")).toBeInTheDocument();
  fixture.state = "bound";
  await screen.rerender(<LinxThreadBindingBadge threadRef={threadRef} />);
  await expect.element(screen.getByText("reviewer · v12 · bbbbbbbb")).toBeVisible();
  expect(slot.getBoundingClientRect().width).toBe(width);
  fixture.state = "unbound";
  await screen.rerender(<LinxThreadBindingBadge threadRef={threadRef} />);
  expect(slot.textContent).toBe("");
  expect(slot.getBoundingClientRect().width).toBe(width);
  fixture.state = "error";
  await screen.rerender(<LinxThreadBindingBadge threadRef={threadRef} />);
  await expect.element(screen.getByText("Expert binding could not be read.")).toBeInTheDocument();
  expect(slot.getBoundingClientRect().width).toBe(width);
});

it("shows the bound Suite revision and both roles in the header", async () => {
  fixture.state = "suite";
  fixture.suiteRole = "lead";
  await using screen = await render(<LinxThreadBindingBadge threadRef={threadRef} />);
  await expect.element(screen.getByText("Suite v5 · Lead")).toBeVisible();
  await expect.element(screen.getByText("Review team")).toBeVisible();
  fixture.suiteRole = "member";
  await screen.rerender(<LinxThreadBindingBadge threadRef={threadRef} />);
  await expect.element(screen.getByText("Suite v5 · Member")).toBeVisible();
  await expect.element(screen.getByText("Suite v5 · Lead")).not.toBeInTheDocument();
});

it("shows the bound Expert revision in member details, but not for a standalone Expert", async () => {
  fixture.state = "suite";
  fixture.suiteRole = "member";
  await using screen = await render(<LinxThreadBindingBadge threadRef={threadRef} memberDetail />);
  const frozenReference = screen.getByText(
    "Frozen Expert snapshot: Frozen Reviewer · v12 · bbbbbbbb",
  );
  await expect.element(frozenReference).toBeVisible();
  fixture.state = "bound";
  await screen.rerender(<LinxThreadBindingBadge threadRef={threadRef} memberDetail />);
  await expect.element(frozenReference).not.toBeInTheDocument();
});

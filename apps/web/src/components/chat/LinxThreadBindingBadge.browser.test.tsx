import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { LinxThreadBindingBadge } from "./LinxThreadBindingBadge";

const fixture = vi.hoisted(() => ({ state: "loading" }));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    isPending: fixture.state === "loading",
    error: fixture.state === "error" ? "failed" : null,
    data:
      fixture.state === "bound"
        ? { expertId: "reviewer", revision: 12, contentHash: "b".repeat(64) }
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

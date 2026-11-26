import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { SidebarBrand } from "./SidebarChrome";

it("names the sidebar brand link with the product name", async () => {
  await using screen = await render(<SidebarBrand onBackdrop={false} />, { router: "/" });

  const link = screen.getByRole("link", { name: "Linxwork" });
  await expect.element(link).toHaveAttribute("href", "/");
  expect(screen.container.querySelector("a svg")).not.toBeNull();
  expect(screen.container.querySelector("a")?.textContent).toBe("Linx.");
});

it("keeps the brand text readable on a stage backdrop", async () => {
  await using screen = await render(<SidebarBrand onBackdrop />, { router: "/" });

  const link = screen.getByRole("link", { name: "Linxwork" });
  await expect.element(link).toHaveAccessibleName("Linxwork");
  expect(screen.container.querySelector("a")?.className).toContain("text-white");
});

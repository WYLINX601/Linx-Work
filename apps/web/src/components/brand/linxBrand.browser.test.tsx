import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { LinxMark } from "./LinxMark";
import { LinxWordmark } from "./LinxWordmark";

describe("LinxMark", () => {
  it("uses the compact dot at 24px and below", async () => {
    await using screen = await render(
      <div>
        {[16, 20, 24, 32, 64, 128].map((size) => (
          <LinxMark key={size} size={size} />
        ))}
      </div>,
    );

    const marks = [...screen.container.querySelectorAll("svg")];
    expect(marks.map((mark) => mark.getAttribute("width"))).toEqual([
      "16",
      "20",
      "24",
      "32",
      "64",
      "128",
    ]);
    expect(marks.map((mark) => mark.querySelector("circle")?.getAttribute("r"))).toEqual([
      "5.2",
      "5.2",
      "5.2",
      "4.2",
      "4.2",
      "4.2",
    ]);
  });

  it("hides decorative marks from assistive technology", async () => {
    await using screen = await render(<LinxMark decorative />);

    const mark = screen.container.querySelector("svg");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.getAttribute("role")).toBeNull();
    expect(mark?.getAttribute("aria-label")).toBeNull();
  });

  it("names non-decorative marks", async () => {
    await using screen = await render(<LinxMark />);

    expect(screen.getByRole("img", { name: "Linx" })).toBeTruthy();
  });

  it("keeps gradient ids unique across instances", async () => {
    await using screen = await render(
      <>
        <LinxMark />
        <LinxMark />
      </>,
    );

    const ids = [...screen.container.querySelectorAll("linearGradient, radialGradient")].map(
      (gradient) => gradient.id,
    );
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });
});

describe("LinxWordmark", () => {
  it("renders the period in the theme-independent brand accent", async () => {
    await using screen = await render(<LinxWordmark />);

    const period = [...screen.container.querySelectorAll("span")].find(
      (element) => element.textContent === ".",
    );
    expect(period).toBeDefined();
    expect(getComputedStyle(period!).color).toBe("rgb(217, 119, 6)");
  });

  it("switches the accent with the dark variant", async () => {
    document.documentElement.classList.add("dark");
    try {
      await using screen = await render(<LinxWordmark />);

      const period = [...screen.container.querySelectorAll("span")].find(
        (element) => element.textContent === ".",
      );
      expect(period).toBeDefined();
      expect(getComputedStyle(period!).color).toBe("rgb(245, 158, 11)");
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });
});

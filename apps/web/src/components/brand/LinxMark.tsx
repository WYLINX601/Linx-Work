import { useId } from "react";

import { cn } from "../../lib/utils";

export type LinxMarkTone = "on-dark" | "on-light" | "auto";

export type LinxMarkProps = {
  /** Rendered width and height in pixels. Values up to 24 use the compact dot. */
  readonly size?: number;
  /** Pin the base color for exports and splash surfaces; default follows `currentColor`. */
  readonly tone?: LinxMarkTone;
  /** Hide the mark from assistive technology when an adjacent label already names the brand. */
  readonly decorative?: boolean;
  readonly className?: string;
};

const BASE_FILLS: Record<Exclude<LinxMarkTone, "auto">, string> = {
  "on-dark": "#FFFFFF",
  "on-light": "#0A0A0A",
};

export function LinxMark({
  size = 24,
  tone = "auto",
  decorative = false,
  className,
}: LinxMarkProps) {
  const gradientId = useId().replaceAll(":", "");
  const shelfGradientId = `linx-shelf-${gradientId}`;
  const coreGradientId = `linx-core-${gradientId}`;
  const baseFill = tone === "auto" ? "currentColor" : BASE_FILLS[tone];

  return (
    <svg
      aria-hidden={decorative ? true : undefined}
      // oxlint-disable-next-line t3code/no-untranslated-copy -- brand name, never translated
      aria-label={decorative ? undefined : "Linx"}
      className={cn("shrink-0", className)}
      fill="none"
      focusable="false"
      height={size}
      role={decorative ? undefined : "img"}
      shapeRendering="geometricPrecision"
      viewBox="17 15 68 68"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={shelfGradientId} x1="0%" x2="0%" y1="0%" y2="100%">
          <stop offset="0%" stopColor="var(--linx-shelf-start)" />
          <stop offset="45%" stopColor="var(--linx-shelf-middle)" />
          <stop offset="100%" stopColor="var(--linx-shelf-end)" />
        </linearGradient>
        <radialGradient cx="38%" cy="34%" id={coreGradientId} r="62%">
          <stop offset="0%" stopColor="var(--linx-core-highlight)" />
          <stop offset="28%" stopColor="var(--linx-core-warm)" />
          <stop offset="68%" stopColor="var(--linx-shelf-middle)" />
          <stop offset="100%" stopColor="var(--linx-shelf-end)" />
        </radialGradient>
      </defs>
      <path d="M22 20H38V64H80V80H22Z" fill={baseFill} />
      <path d="M38 38H52V64H38Z" fill={`url(#${shelfGradientId})`} />
      <rect
        fill={baseFill}
        height="16"
        rx="2"
        transform="rotate(45 70 30)"
        width="16"
        x="62"
        y="22"
      />
      <circle cx="70" cy="55" fill={`url(#${coreGradientId})`} r={size <= 24 ? 5.2 : 4.2} />
    </svg>
  );
}

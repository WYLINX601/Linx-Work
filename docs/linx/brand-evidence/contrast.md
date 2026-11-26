# Linx theme contrast

Measured with the WCAG 2.1 relative-luminance formula against the values in
`LINX_LIGHT_THEME_COLORS` / `LINX_DARK_THEME_COLORS`
(`packages/shared/src/themePalettes.ts`). Recompute with any standard contrast checker;
the palette test suite (`themePalette.test.ts`, `mobileTheme.test.ts`,
`clerkAppearance.test.ts`) additionally enforces ≥4.5:1 on the roles those tests cover.

| Foreground | Background | Ratio   | Result |
| ---------- | ---------- | ------- | ------ |
| `#FFFFFF`  | `#0A0A0A`  | 19.80:1 | AAA    |
| `#A1A1AA`  | `#0A0A0A`  | 7.72:1  | AAA    |
| `#A1A1AA`  | `#1F1F24`  | 6.40:1  | AAA    |
| `#A1A1AA`  | `#141416`  | 7.18:1  | AAA    |
| `#0A0A0A`  | `#F59E0B`  | 9.22:1  | AAA    |
| `#0A0A0A`  | `#FBBF24`  | 11.86:1 | AAA    |
| `#0A0A0A`  | `#FAFAFA`  | 18.97:1 | AAA    |
| `#52525B`  | `#FAFAFA`  | 7.41:1  | AAA    |
| `#52525B`  | `#F4F4F5`  | 7.03:1  | AAA    |
| `#2A2A2A`  | `#D97706`  | 4.51:1  | AA     |
| `#FFFFFF`  | `#B45309`  | 5.02:1  | AA     |

Notes:

- `#D97706` primary buttons use `#2A2A2A` text. White text on `#D97706` is 3.19:1 and
  must not be used.
- Light `focus` is `#D97706` (3.05:1 against `#FAFAFA`); `accent`/links use `#B45309`
  (5.02:1) where the ring or text needs the stronger ratio.
- The wordmark period uses the theme-independent `--linx-accent` (`#D97706` light,
  `#F59E0B` dark); it is decorative and never carries text contrast requirements.

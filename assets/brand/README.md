# Linx brand marks

Production copies of the Linx mother mark. The source of truth, provenance, and
validation hashes live in the design archive
(`docs/design/linx-brand/` in the LinxWorkOS planning repo); this directory holds
only what the app and the icon pipelines consume.

| File                             | Surface                                     | Sizes    |
| -------------------------------- | ------------------------------------------- | -------- |
| `linx-mark-on-dark.svg`          | dark background, white base                 | ≥ 32 px  |
| `linx-mark-on-light.svg`         | light background, `#0A0A0A` base            | ≥ 32 px  |
| `linx-mark-compact-on-dark.svg`  | dark background, larger core dot (`r=5.2`)  | 16–24 px |
| `linx-mark-compact-on-light.svg` | light background, larger core dot (`r=5.2`) | 16–24 px |

## Rules

- The full canvas is `viewBox="0 0 100 100"`, with content bounds about
  `x=22–80`, `y=18.7–80`. Keep the canvas and its padding for app icons, the
  DMG, and marketing art.
- In-app UI uses the tight crop `viewBox="17 15 68 68"` so the mark fills a
  16–24 px slot. This crop exists only in `LinxMark`; do not rewrite the SVGs.
- Base and floating diamond use `currentColor` in the React component. The
  shelf and core gradients are fixed brand colors and never follow the theme.
- No animation. The master HTML's `caustic-drift` motion is for marketing only.
- The wordmark is typeset, not vector: `Linx` plus an amber `.` that uses the
  `--linx-accent` token so it survives every in-app theme.
- Never bake the wordmark into the mark SVG, and never hand-edit the generated
  PNG/ICO exports under `assets/{dev,nightly,prod}`.

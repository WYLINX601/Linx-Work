# Linx brand refresh — evidence

Status: local working tree on `linx/integration`, baseline `0f718fc56843` (2026-11-26).
The changes are **not committed and not opened as a PR**; there is no candidate SHA yet.

Environment: macOS 27.2.0, Node 22.23.1, pnpm 12.14.0, Playwright Chromium 1.64.1,
Icon Composer 27.2 (build 143) at `/Applications/Icon Composer.app`.

## Automated checks that passed

```sh
vp run check:changed HEAD   # format, lint, knip, graphql, typecheck (43 packages),
                            # changed-file tests, React Compiler coverage
vp test run apps/web/src/themeBoot.test.ts apps/web/src/themePalette.test.ts \
  apps/web/src/themePalette.browser.test.ts apps/web/src/themeCss.browser.test.ts \
  apps/mobile/src/lib/mobileTheme.test.ts apps/mobile/src/lib/composerChipPresentation.test.ts \
  apps/web/src/components/clerk/clerkAppearance.test.ts
vp test run apps/web/src/components/brand/linxBrand.browser.test.tsx \
  apps/web/src/components/sidebar/SidebarBrand.browser.test.tsx \
  apps/web/src/versionSkew.test.ts apps/web/src/components/desktopUpdate.logic.test.ts \
  apps/web/src/components/sidebar/updateEverythingRun.test.ts
vp test run apps/desktop/src/app/DesktopEnvironment.test.ts \
  apps/desktop/src/app/DesktopAppIdentity.test.ts \
  apps/desktop/src/app/DesktopPreReadyPlatform.test.ts \
  scripts/build-desktop-artifact.test.ts scripts/apply-web-brand-assets.test.ts
vp run i18n:check
vp run icons:check            # Icon Composer 27.2, design generation 26: all 33 assets current
vp run icons:export
vp run icons:export:android   # regenerated foreground, monochrome, backgrounds and splashes
node apps/mobile/scripts/generate-uniwind-themes.mts
vp run dist:desktop:dmg:arm64 # produced release/Linxwork-0.1.11-arm64.dmg
```

## Generated icon evidence

The macOS classic exports were produced in Icon Composer 27.2 with
Platform `macOS pre-Tahoe`, Appearance `Default`, Size `1024pt`, Scale `1×`, and
design generation 26 (matching `icons:export`):

| File                                    | Opaque body | Insets           |
| --------------------------------------- | ----------- | ---------------- |
| `assets/prod/black-macos-1024.png`      | 824×824     | 100 px each side |
| `assets/dev/blueprint-macos-1024.png`   | 824×824     | 100 px each side |
| `assets/nightly/nightly-macos-1024.png` | 824×824     | 100 px each side |

Windows ICO exports contain 16/24/32/48/64/128/256; web favicons and PWA icons are
16/32/180/192/512. `assets/prod/black-ios-1024.png` shows the full-bleed design.

## Packaged app

`vp run dist:desktop:dmg:arm64` (version `0.1.11`) produced
`release/Linxwork-0.1.11-arm64.dmg` (226 MB), its zip, and `latest-mac.yml`.

Verified from the mounted DMG:

- Bundle `Linxwork.app`; `CFBundleName` / `CFBundleDisplayName` = `Linxwork`;
  `CFBundleIdentifier` = `com.linx.work`; `CFBundleIconFile` = `icon.icns`.
- `icon.icns` renders the new mark: `screenshots/dmg-built-app-icon-1024.png`.
- DMG background contains the mark and `Drag Linxwork into Applications.`:
  `screenshots/dmg-built-background-640x432.png`.
- `latest-mac.yml` references `Linxwork-0.1.11-arm64.zip` / `.dmg`.
- The packaged `app.asar` contains `Linxwork (Beta)` and the
  `LINX_SAFE_STORAGE_APP_BASE_NAME` shim.

The app was not launched: it would share `~/Library/Application Support/linxworkos`
with the live install. Menu/About/window-title copy is covered by the unit tests and
by the asar inspection above.

## Theme matrix

Playwright opened the appearance settings, clicked each of the seven theme cards, and
read the applied variables after each switch. The standard `T3 Code` card intentionally
sets no `--app-theme-*` variables; the six named themes each set 61 variables with no
empty values. `Linx` was restored last. Screenshots:
`screenshots/theme-{t3-code,linx,t3-chat,grove,ocean,ember,iris}-dark-100.png`.

## Visual evidence

Captured from the web dev app started with a throwaway home
(`node scripts/dev-runner.ts dev --home-dir /tmp/linx-brand-smoke --port 3799 --no-seed`),
1440×900 at 2× scale. The fresh profile had no stored theme and booted into `linx`,
following the OS light/dark setting.

| File                                           | Surface                                          | Mode  |
| ---------------------------------------------- | ------------------------------------------------ | ----- |
| `screenshots/home-dark-100.png`                | Sidebar lockup + composer                        | dark  |
| `screenshots/home-light-100.png`               | Sidebar lockup + composer                        | light |
| `screenshots/settings-themes-dark-100.png`     | Theme cards (`Linx` first, selected)             | dark  |
| `screenshots/pair-dark-100.png`                | Standalone pairing header + amber primary button | dark  |
| `screenshots/theme-*-dark-100.png`             | Seven-theme switch matrix                        | dark  |
| `screenshots/dmg-latest-1280x864.png`          | Latest DMG background (SVG render)               | light |
| `screenshots/dmg-nightly-1280x864.png`         | Nightly DMG background (SVG render)              | dark  |
| `screenshots/dmg-built-background-640x432.png` | Built DMG background                             | light |
| `screenshots/dmg-built-app-icon-1024.png`      | Built app icon from the DMG bundle               | —     |
| `screenshots/android-splash-prod.png`          | Android 12 splash composite (432 dp source)      | dark  |

## Not verified here (blocked or out of scope)

- Desktop app launch for menu, About panel, window title, and update dialogs; the
  packaged app shares the live userData directory, so it was inspected statically
  instead. See [upgrade.md](upgrade.md) for the upgrade drill.
- Windows NSIS and Linux AppImage packages were not built on this macOS host; their
  icon inputs (ICO sizes, PNG set) are generated and verified.
- SafeStorage upgrade drill against a real old profile; see [upgrade.md](upgrade.md).

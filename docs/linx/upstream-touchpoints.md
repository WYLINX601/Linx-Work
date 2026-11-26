# Upstream touchpoints

Files this fork shares with upstream T3 Code that the brand refresh changed. On an
upstream sync, resolve conflicts by keeping the upstream structure and re-applying the
brand substitution described here; do not reintroduce T3 display names or palette values.

| File                                                         | Change                                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `apps/web/index.html`                                        | Brand boot palettes and splash colors, `linx` reserved id, default theme fallback, static title, splash alt text |
| `apps/web/public/manifest.webmanifest`                       | `Linxwork` name, `Linx` short name, `#0A0A0A` colors                                                             |
| `apps/web/src/index.css`                                     | `--linx-accent` and fixed mark gradients; standard theme untouched                                               |
| `packages/shared/src/themePalettes.ts`                       | Adds `LINX_THEME` first in `BUILT_IN_THEMES`; standard palettes unchanged                                        |
| `apps/web/src/themePalette.ts`                               | Re-exports `LINX_THEME`                                                                                          |
| `apps/web/src/hooks/useTheme.ts`                             | Default theme is `linx`; `linx` follows the OS until an appearance mode is stored                                |
| `apps/web/src/themeBoot.test.ts`                             | Default-theme parity cases and `linx` boot splash assertions                                                     |
| `apps/web/src/components/settings/ThemeSettings.tsx`         | `Linx` first in the maintainer theme cards                                                                       |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`          | `LinxLockup` in the brand slot; width probe uses the same component                                              |
| `apps/web/src/components/ui/standalone-page.tsx`             | `LinxLockup` in the page header                                                                                  |
| `apps/web/src/components/chat/V2LifecycleRow.tsx`            | Timeline icon uses `LinxMark`                                                                                    |
| `apps/web/src/components/chat/TimelineToolActivityIcon.tsx`  | `t3-code` work-entry icon uses `LinxMark`                                                                        |
| `apps/web/src/connection/clientMetadata.ts`                  | Client labels use `APP_BASE_NAME`                                                                                |
| `apps/web/src/versionSkew.ts`                                | Version-mismatch copy uses the product name                                                                      |
| `apps/web/src/components/desktopUpdate.logic.ts`             | Rosetta and install-confirmation copy use the product name                                                       |
| `apps/web/src/components/sidebar/UpdateEverythingDialog.tsx` | Update table uses the product name                                                                               |
| `apps/web/src/components/sidebar/updateEverythingRun.tsx`    | Not-applied toast uses the product name                                                                          |
| `packages/shared/src/linxIdentity.ts`                        | Display name `Linxwork`; separate `LINX_SAFE_STORAGE_APP_BASE_NAME`                                              |
| `apps/desktop/package.json`                                  | `productName: Linxwork`                                                                                          |
| `apps/desktop/src/app/DesktopEnvironment.ts`                 | Branding display name (uses the shared constant)                                                                 |
| `apps/desktop/src/app/DesktopAppIdentity.ts`                 | About panel uses the display name; `app.setName` keeps the pre-rename value for safeStorage                      |
| `apps/desktop/src/window/DesktopApplicationMenu.ts`          | Menu and update dialog copy use the product name                                                                 |
| `apps/desktop/src/app/DesktopApp.ts`                         | Startup-failure dialog uses the product name                                                                     |
| `scripts/export-android-icons.ts`                            | Mark bounds and full-SVG rasterization; also emits the monochrome icon                                           |
| `apps/desktop/resources/dmg/dmg-background-latest.svg`       | Linx mark and `Drag Linxwork into Applications.`                                                                 |
| `apps/desktop/resources/dmg/dmg-background-nightly.svg`      | Linx mark and `Drag Linxwork into Applications.`; sky art unchanged                                              |

New brand files live outside upstream paths: `assets/brand/`,
`apps/web/src/components/brand/`, `docs/linx/brand-evidence/`.

After an upstream merge that touches user-facing copy in the files above, run
`vp run i18n:generate` in `apps/web` and `apps/desktop` so catalog hashes match the source.

## Release & updater touchpoints

Files shared with upstream T3 Code that point updates at `WYLINX601/Linx-Work` and guard
unsigned macOS builds from running Squirrel.Mac in-app installs (see [release.md](release.md)):

| File                                                                       | Change                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/linxIdentity.ts`                                      | Single source `LINX_RELEASE_REPOSITORY = "WYLINX601/Linx-Work"`                                                                            |
| `packages/shared/src/cliRelease.ts`                                        | Uses `LINX_RELEASE_REPOSITORY` instead of `pingdotgg/t3code`                                                                               |
| `packages/contracts/src/ipc.ts`                                            | Optional `manualDownloadOnly?: true` on `DesktopUpdateState` / `DesktopUpdateStateSchema`                                                  |
| `scripts/build-desktop-artifact.ts`                                        | Defaults GitHub publish config to `LINX_RELEASE_REPOSITORY`; emits `linxManualUpdateOnly: true` for unsigned non-mock macOS builds         |
| `scripts/install.sh`, `scripts/install.ps1`, `scripts/npm-launcher/t3.mjs` | Default release repository set to `WYLINX601/Linx-Work`                                                                                    |
| `apps/desktop/src/updates/DesktopUpdates.ts`                               | Reads `linxManualUpdateOnly`, sets `canInstallUpdates = false`, and refuses in-app `download` / `install` while keeping update checks live |
| `apps/desktop/src/updates/remoteUpdateFlow.ts`                             | Fails closed immediately when `manualDownloadOnly === true`                                                                                |
| `apps/desktop/src/window/DesktopApplicationMenu.ts`                        | Opens the `WYLINX601/Linx-Work` release tag externally on `manualDownloadOnly` builds instead of calling `updates.download`                |
| `apps/web/vite.config.ts`                                                  | Defaults `T3CODE_DESKTOP_UPDATE_REPOSITORY` to `LINX_RELEASE_REPOSITORY`                                                                   |
| `apps/web/src/components/desktopUpdate.logic.ts`                           | Defaults release repo to `LINX_RELEASE_REPOSITORY`; returns `"open-release"` action for `manualDownloadOnly` available updates             |
| `apps/web/src/components/sidebar/SidebarUpdatePill.tsx`                    | Routes `"open-release"` to `openExternal` and excludes manual builds from Update Everything local restarts                                 |
| `apps/web/src/components/settings/SettingsPanels.tsx`                      | Routes `"open-release"` to `openExternal` and excludes manual builds from `appOffTrack`                                                    |
| `apps/web/src/components/settings/updateTrackSwitch.logic.ts`              | `localUpdaterStaysPut` returns `true` when `manualDownloadOnly === true`                                                                   |

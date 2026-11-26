# Rename and upgrade record (`LinxWorkOS` → `Linxwork`)

## What changes

- OS display name: `Linxwork`, `Linxwork (Beta)`, `Linxwork (Nightly)`, `Linxwork (Dev)`.
- `productName` / macOS bundle name: `Linxwork`; preview/`latest` DMG artifact:
  `Linxwork-${version}-${arch}.dmg` (nightly keeps `Linxwork (Nightly)`).
- About panel, macOS menu labels, window title, startup-failure dialog, update dialogs,
  client labels, and version-mismatch copy.

## What does not change

`com.linx.work` / `com.linx.work.dev` app ids, `linx` / `linx-dev` URL schemes,
`~/.linxworkos` home, `linxworkos` / `linxworkos-dev` userData directories, server ports,
and the MCP secret service `com.linx.work.mcp`.

`.github/workflows/release-desktop.yml` selects `release/*.dmg` by glob, so the artifact
rename does not need a workflow or manifest filename change.

## SafeStorage

Electron derives the macOS Keychain item from the Electron app name. Renaming that name
would make an existing profile's encrypted catalog unreadable. To keep upgrades safe:

- `LINX_SAFE_STORAGE_APP_BASE_NAME = "LinxWorkOS"` in `packages/shared/src/linxIdentity.ts`.
- `DesktopAppIdentity.configure` keeps `app.setName("LinxWorkOS <stage>")` for
  `safeStorage`, while every user-visible name comes from `productName` / branding and the
  explicitly configured About panel and menus.
- The display name and the persisted app name are intentionally different; see
  [identity.md](../identity.md#keychain--safestorage).

## Drill status

The upgrade drill has **not** been executed. Icon Composer 27.2 is installed,
`release/Linxwork-0.1.11-arm64.dmg` was built and inspected, and the packaged `app.asar`
contains the `LINX_SAFE_STORAGE_APP_BASE_NAME` shim. The candidate was **not installed or
launched** because it would share the live `~/Library/Application Support/linxworkos`
profile and Keychain entries with the running install. Treat the drill as a
merge/release gate:

1. Use a pre-change build to create a profile with an environment credential; record the
   `linxworkos` userData path and `security dump-keychain | grep -i "Safe Storage"` entry.
2. Install the candidate over it and launch.
3. Confirm the same data directory is read and the saved connection can still decrypt;
   check the window title, About panel, menu, and update dialog show `Linxwork`.
4. If decryption fails, stop the release and add a one-time migration read (or revert the
   display-name commit). MCP secrets use the fixed `com.linx.work.mcp` service and are not
   affected.

## Rollback

The rename is confined to the P2 commit. Reverting it restores `LinxWorkOS` display names
without touching data directories, app id, scheme, ports, or Keychain service names.

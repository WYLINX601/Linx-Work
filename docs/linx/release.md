# Linxwork 发版与升级开发规范

本文定义 `WYLINX601/Linx-Work` 的日常开发升级红线、正式发版流程与验包门禁。身份常量与隔离基线见 [identity.md](identity.md)，上游同步规范见 [baseline.md](baseline.md) 与 [upstream-touchpoints.md](upstream-touchpoints.md)。

---

## 1. 升级架构约定

Linxwork 复用上游 T3 Code 的 `electron-updater` 检测与状态机，发布源统一收敛在 `packages/shared/src/linxIdentity.ts` 的 `LINX_RELEASE_REPOSITORY = "WYLINX601/Linx-Work"`：

- **未传 `--signed` 的 macOS 正式 SemVer 构建（当前默认）**：使用 ad-hoc 临时签名，照常写入指向 `WYLINX601/Linx-Work` 的 `app-update.yml` 并生成 `latest-mac.yml`；同时在打包 `package.json` 写入 `linxManualUpdateOnly: true`。客户端自动/手动检测到新版本并展示 Release Notes，点击后跳转 GitHub Releases 手动下载 `.dmg` 拖入 `/Applications` 覆盖安装，不触发 Squirrel.Mac 应用内替换。
- **传 `--signed` 的正式签名构建（未来接 Apple Developer ID + 公证后）**：不写入 `linxManualUpdateOnly`，自动回归 T3 原生应用内下载与重启安装，无需重写升级代码。
- **`-preview` / `-pr` 预览构建**：不写入更新源（`publish: null`），仅用于本地或内测验证，不参与线上升级检测。

---

## 2. 开发阶段升级安全红线

每次开发面向下一版本的功能时，必须守住以下不变量，确保用户覆盖安装新版后数据无损、升级链路不回退：

1. **禁止改动持久化与 Keychain 标识**
   - 保持 `LINX_HOME_DIR_NAME`（`.linxworkos`）、`LINX_DESKTOP_USER_DATA_DIR`（`linxworkos`）、`LINX_DESKTOP_APP_ID`（`com.linx.work`）和 `LINX_SAFE_STORAGE_APP_BASE_NAME`（`LinxWorkOS`）不变。改动其中任一项都会导致旧用户数据目录失联或 macOS Keychain 密钥无法解密。
2. **数据库迁移只增不改**
   - `apps/server/src/linx/persistence/Migrations/` 下的历史迁移文件一经发布**严禁修改或重排编号**；新表结构变更只能追加更高编号的新迁移文件并注册到 `Migrations.ts`。
   - 不直接读取或篡改旧版 `Linx.app`（`~/.linx`）或 Synara 的数据库；跨产品导入走独立导出/导入迁移流程。
3. **禁止新增 `pingdotgg/t3code` 更新/发布硬编码**
   - 所有更新检测、Release 链接、下载脚本和打包配置必须从 `@t3tools/shared/linxIdentity` 的 `LINX_RELEASE_REPOSITORY`（或显式环境变量覆盖）解析，不得回落到上游仓库。
4. **面向用户的文案变更必须同步 i18n 目录**
   - 修改或新增 `gt(...)` / `msg(...)` / `<T>` 文案后，必须运行 `vp run i18n:check`；如有新增 key，在对应 app 执行 `vp run i18n:generate` 并补齐全部语言目录，避免 CI 漂移失败。
5. **上游同步时核对更新触点**
   - 合并上游 T3 Code 后，逐项复核 [upstream-touchpoints.md](upstream-touchpoints.md) 中的品牌与更新触点，确认 `LINX_RELEASE_REPOSITORY` 与 `manualDownloadOnly` 守卫未被冲掉。

---

## 3. 版本号与 GitHub Release 规则

| 项                             | 规则                                                                 | 原因                                                                                               |
| ------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 版本格式                       | 严格递增的**正式 SemVer**（如 `0.1.24`、`0.2.0`），禁止带 `-preview` | `build-desktop-artifact.ts` 对 `-preview` 禁用 `publish`；且 `semver` 比较要求新版本严格大于旧版本 |
| Git Tag                        | `v<version>`（如 `v0.1.24`）                                         | 与客户端跳转的 `/releases/tag/v<version>` 及 `electron-updater` 匹配                               |
| Release 类型                   | **正式 Release**（禁止勾选 `Draft` 或 `Pre-release`）                | GitHub `/releases/latest` 与 `electron-updater` 默认稳定轨道会跳过 Draft 与 Pre-release            |
| Release 仓库                   | `https://github.com/WYLINX601/Linx-Work/releases`（Public）          | 公开库支持匿名检测与下载                                                                           |
| 必传资产（当前未签名阶段）     | `Linxwork-<version>-arm64.dmg` + **`latest-mac.yml`**                | `electron-updater` 靠 `latest-mac.yml` 判定新版，用户点击后下载 `.dmg` 手动覆盖                    |
| 额外资产（启用 `--signed` 后） | 同上，再补传 `Linxwork-<version>-arm64.zip` 与 `.blockmap`           | Squirrel.Mac 应用内更新需要 `.zip` 和差量 `.blockmap`                                              |

> **正文（Release Notes）**：客户端悬停更新浮层会直接解析展示 GitHub Release 正文，建议用简洁的 Markdown 列表写明本版变更。

---

## 4. 发版前验证门禁

发版提交必须在 `linx/integration` 分支上通过以下检查（工具链路径按本机环境设置）：

```sh
export TMPDIR=/tmp
export PATH="$PWD/node_modules/.bin:/Volumes/LinxSpace/toolchain/node-v26.13.1-darwin-arm64/bin:$PATH"

# 1. 基线与工作区校验
node scripts/linx/verify-baseline.ts

# 2. 格式、Lint、i18n 与死代码检查
vp fmt --check
vp lint
vp run i18n:check
vp run knip:check

# 3. 核心包类型检查
vp run \
  --filter @t3tools/shared \
  --filter @t3tools/contracts \
  --filter @t3tools/desktop \
  --filter @t3tools/web \
  --filter t3 \
  --filter @t3tools/scripts \
  typecheck

# 4. 更新与打包核心测试（TMPDIR=/tmp 避免点目录影响 asar 测试）
vp test run \
  packages/shared/src/cliRelease.test.ts \
  apps/server/src/cli/update.test.ts \
  apps/desktop/src/updates/DesktopUpdates.test.ts \
  apps/desktop/src/updates/remoteUpdateFlow.test.ts \
  apps/desktop/src/updates/DesktopRemoteUpdates.test.ts \
  apps/desktop/src/window/DesktopApplicationMenu.test.ts \
  apps/web/src/components/desktopUpdate.logic.test.ts \
  apps/web/src/components/settings/updateTrackSwitch.logic.test.ts \
  apps/web/src/components/sidebar/SidebarUpdatePill.browser.test.tsx \
  scripts/build-desktop-artifact.test.ts
```

确认全部通过后再 commit，并确保工作区干净（`git status -s` 为空），以保证包内 `t3codeCommitHash` 指向已提交的准确 SHA。

---

## 5. 本地打包与验包清单

### 5.1 打包命令（macOS arm64）

```sh
export VERSION="0.1.24" # 替换为本次正式 SemVer
export TMPDIR=/tmp
export CARGO_HOME=/Volumes/LinxSpace/toolchain/rust-linxworkos/cargo
export RUSTUP_HOME=/Volumes/LinxSpace/toolchain/rust-linxworkos/rustup
export PATH="$PWD/node_modules/.bin:/Volumes/LinxSpace/toolchain/node-v26.13.1-darwin-arm64/bin:/Volumes/LinxSpace/toolchain/rust-linxworkos/cargo/bin:$PATH"
unset T3CODE_DESKTOP_UPDATE_REPOSITORY GITHUB_REPOSITORY

node scripts/build-desktop-artifact.ts \
  --platform mac \
  --target dmg \
  --arch arm64 \
  --build-version "$VERSION" \
  --output-dir "release/linxwork-$VERSION"
```

### 5.2 必做验包 3 项（上传 Release 前）

```sh
OUT="release/linxwork-$VERSION"
ZIP="$OUT/Linxwork-$VERSION-arm64.zip"

# 1. 校验 latest-mac.yml 存在且版本号匹配
cat "$OUT/latest-mac.yml"

# 2. 校验包内 app-update.yml 指向 WYLINX601/Linx-Work
unzip -p "$ZIP" "Linxwork.app/Contents/Resources/app-update.yml"

# 3. 校验 app.asar/package.json 中的 version、commitHash 与 linxManualUpdateOnly
tmp=$(mktemp -d /tmp/linx-verify-asar.XXXXXX)
unzip -q "$ZIP" "Linxwork.app/Contents/Resources/app.asar" -d "$tmp"
node --input-type=module -e '
  import { createRequire } from "node:module";
  const asar = createRequire(process.cwd() + "/scripts/package.json")("@electron/asar");
  const pkg = JSON.parse(asar.extractFile(process.argv[1], "package.json").toString("utf8"));
  console.log({
    version: pkg.version,
    buildVersion: pkg.buildVersion,
    t3codeCommitHash: pkg.t3codeCommitHash,
    linxManualUpdateOnly: pkg.linxManualUpdateOnly,
  });
' "$tmp/Linxwork.app/Contents/Resources/app.asar"
rm -rf "$tmp"
```

验收标准：

- `latest-mac.yml` 中 `version` 等于 `$VERSION`；
- `app-update.yml` 包含 `owner: WYLINX601`、`repo: Linx-Work`、`provider: github`、`releaseType: release`；
- 未签名构建中 `linxManualUpdateOnly: true`（若使用 `--signed` 正式签名，则为 `undefined`）；
- `git status -s` 保持干净（脚本会自动还原临时修改的 `package.json` 版本号）。

---

## 6. 发布与升级注意事项

1. **推送代码并发布 Release**：
   - `git push origin linx/integration`
   - 在 `https://github.com/WYLINX601/Linx-Work/releases/new` 创建 Tag `v<version>`（指向本次发布提交），填写中文/双语更新说明，上传 `.dmg` 与 `latest-mac.yml`，点击 **Publish release**（不要勾选 Pre-release / Draft）。
2. **品牌更名过渡提示（`0.1.23` → `0.1.24+`）**：
   - 品牌刷新后 macOS 应用包名由 `LinxWorkOS.app` 变为 `Linxwork.app`。首次从 `0.1.23` 升级时，将 `Linxwork.app` 拖入 `/Applications` 后手动删除旧的 `/Applications/LinxWorkOS.app` 即可；二者共用 `~/.linxworkos`、`~/Library/Application Support/linxworkos` 与 `LinxWorkOS` Keychain 条目，配置、对话和密钥自动继承。
3. **未来切换正式签名自动更新（方案 A）**：
   - 配置 Apple Developer ID 证书与公证环境变量后，在打包命令中增加 `--signed` 并在 GitHub Release 同时上传 `.dmg`、`.zip`、`.blockmap` 和 `latest-mac.yml`，即可自动启用原生应用内静默下载与重启替换。

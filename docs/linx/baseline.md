# Linx 实施基线

固定 T3 基线，禁止跟随浮动 `main`。升级走单独的 upstream sync 分支与 PR。

## 仓库与分支

| 角色     | 地址                                         | 说明                               |
| -------- | -------------------------------------------- | ---------------------------------- |
| upstream | `https://github.com/pingdotgg/t3code.git`    | 只读参照                           |
| fork     | `https://github.com/WYLINX601/Linx-Work.git` | 实施仓库                           |
| 开发分支 | `linx/integration`                           | 从固定 SHA 起，不直接提交到 `main` |
| 升级分支 | `linx/upstream-<sha>`                        | 每次升级单独评审                   |

`main` 只用于吸收 upstream 对象（fast-forward），不作为开发分支。

## 固定版本

| 项                       | 值                                                                 |
| ------------------------ | ------------------------------------------------------------------ |
| 基线 Commit              | `c6e32aa4ebe0364eaf226003d40d54546d89f418`                         |
| Commit 时间              | 2026-11-24 14:57:52 UTC                                            |
| Node                     | `26.13.1`（`vp` 固定）                                             |
| pnpm                     | `12.14.0`（`packageManager`）                                      |
| `pnpm-lock.yaml` SHA-256 | `625aa8e82444c8e6e14134a1303cb98d8cd80fc0dfa2c19b77650d33d81662a5` |

本次从原基线 `5b2299ca0a471f1ac9263b0e313f2b4394700d48` 合入 `origin/main` 的 84 个提交（merge `612228e7`）；锁文件未变。下方 2026-11-25 本地验证保留为原基线的历史记录。

## 重建

```sh
git clone https://github.com/WYLINX601/Linx-Work.git
cd Linx-Work
git switch linx/integration
vp i
node scripts/linx/verify-baseline.ts
```

`vp` 安装与固定 Node 版本见 <https://viteplus.dev/guide/>。无 `vp` 时可用 Node 24.13+ 与 pnpm 12.14 执行同一流程，但 CI 以 `vp` 为准。

## 最小回归

```sh
vp run check:changed
vp test run apps/server/src/config.test.ts scripts/dev-runner.test.ts
vp run dev:server --dry-run
```

原生桌面基线（P0 准出）另需手工记录：

```sh
vp run dev
vp run dev:desktop
```

## 漂移检查

```sh
node scripts/linx/verify-baseline.ts
node scripts/linx/verify-baseline.ts --allow-dirty   # 开发中跳过工作树清洁检查
```

脚本校验：HEAD 可追溯到固定 Commit、当前分支属于 `linx/*`、锁文件哈希匹配；`--allow-dirty` 只跳过工作树清洁检查。

## 身份与隔离

见 [identity.md](identity.md)。默认值：

| 项               | Linx                | 上游 T3 Code               | Synara                        |
| ---------------- | ------------------- | -------------------------- | ----------------------------- |
| Home             | `~/.linx`           | `~/.t3`                    | `~/.synara`                   |
| 默认端口         | `3774`              | `3773`                     | `3773`                        |
| dev server / web | `13774` / `5734`    | `13773` / `5733`           | —                             |
| App ID           | `com.linx.work`     | `com.t3tools.t3code`       | `com.emanueledipietro.synara` |
| URL Scheme       | `linx` / `linx-dev` | `t3code` / `t3code-dev`    | —                             |
| UserData         | `linx` / `linx-dev` | `t3code-v2` / `t3code-dev` | `synara-*`                    |

## 本地验证（2026-11-25）

| 检查                                                                                   | 结果                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/linx/verify-baseline.ts`（干净树）                                       | 通过                                                                                                                                                            |
| 篡改 `pnpm-lock.yaml` 后运行                                                           | 退出码 1，哈希不匹配                                                                                                                                            |
| `vp fmt --check` / `vp lint`（改动文件）                                               | 通过                                                                                                                                                            |
| `effect-tsgo tsrs --noEmit`：shared、contracts、desktop、server、web、scripts          | 通过                                                                                                                                                            |
| 共享层测试（devHome、remote、promptLinks、auth return、codex handoff、managed policy） | 41 passed，1 skipped                                                                                                                                            |
| 桌面身份/隔离测试（17 文件）                                                           | 255 passed，16 skipped                                                                                                                                          |
| 服务端身份/服务/策略测试（17 文件）                                                    | 435 passed，2 skipped                                                                                                                                           |
| `scripts/dev-runner.test.ts`                                                           | 43 passed                                                                                                                                                       |
| `scripts/build-desktop-artifact.test.ts`                                               | 55 passed                                                                                                                                                       |
| `vp run check:changed 5b2299ca`                                                        | format、lint、knip、graphql、unused patches 通过；全量 typecheck/test 被本机未完整安装的 mobile 原生依赖和 3 个 macOS 临时路径/符号链接测试阻断，不计入身份改动 |

## 约束

- 不修改 T3 `ProviderAdapter` 实现，除非能力验证证明无其他接入点。
- 所有 T3 内部依赖集中在 `apps/server/src/linx/adapters/t3`。
- upstream 升级不以“冲突文件少”为成功标准；以集成边界稳定与回归通过为准。

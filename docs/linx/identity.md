# Linx 身份与隔离

单一身份源：`packages/shared/src/linxIdentity.ts`。所有默认值从这里读取，测试锁定消费方行为。

## 默认值

| 项                      | Linx                                                  | 上游 T3 Code                                                    | Synara                        |
| ----------------------- | ----------------------------------------------------- | --------------------------------------------------------------- | ----------------------------- |
| 产品名                  | `LinxWorkOS`                                          | `T3 Code`                                                       | `Synara`                      |
| App ID                  | `com.linx.work`                                       | `com.t3tools.t3code`                                            | `com.emanueledipietro.synara` |
| URL Scheme              | `linx` / `linx-dev`                                   | `t3code` / `t3code-dev`                                         | —                             |
| Home                    | `~/.linx`                                             | `~/.t3`                                                         | `~/.synara`                   |
| UserData                | `linx` / `linx-dev`                                   | `t3code-v2` / `t3code-dev`                                      | `synara-*`                    |
| Server 端口             | `3774`                                                | `3773`                                                          | `3773`                        |
| Dev server / web        | `13774` / `5734`                                      | `13773` / `5733`                                                | —                             |
| Linux desktop entry     | `com.linx.work.desktop`                               | `com.t3tools.T3Code.desktop`                                    | —                             |
| systemd / launchd       | `linx.service` / `com.linx.work.service`              | `t3code.service` / `com.t3tools.t3code.service`                 | —                             |
| Windows 服务目录 / 任务 | `%LOCALAPPDATA%\linx` / `linx-<domain>-<user>`        | `%LOCALAPPDATA%\t3code` / `t3code-*`                            | —                             |
| 托管策略                | `com.linx.work.policy`、`SOFTWARE\Policies\Linx\Linx` | `com.t3tools.t3code.policy`、`SOFTWARE\Policies\T3Tools\T3Code` | —                             |

## Keychain / safeStorage

桌面端使用 Electron `safeStorage`，密钥条目由 **应用名 + `app.getPath("userData")`** 决定：

- 显示名：`LinxWorkOS (Beta)` / `LinxWorkOS (Nightly)` / `LinxWorkOS (Dev)`；macOS 预览安装包为 `LinxWorkOS.app`。
- UserData：`~/Library/Application Support/linx`（prod）或 `linx-dev`（dev）。
- 上游 T3 Code 的 `t3code-v2` / `T3 Code (Dev)` 不再被读取或迁移。

手工核对（macOS）：

```sh
security dump-keychain | grep -i "LinxWorkOS Safe Storage"
ls -d "$HOME/Library/Application Support/linx" "$HOME/Library/Application Support/linx-dev"
```

不要把 Keychain 内容写入日志、测试夹具或仓库。

## 保留的上游接口

以下名称保留，原因是它们属于上游接口或尚未进入 P0.2 范围；它们不共享可变状态：

- `T3CODE_*` 环境变量：upstream 兼容接口。显式设置时优先于 Linx 默认值。
- CLI 可执行名 `t3` 与 launcher 内部参数 `--t3code-dev-root`：改名会扩散到打包与文档，单独评估。
- 遥测 service name（`t3code-server`、`t3code` namespace）：不影响本地状态隔离。
- 运行时工具名称、图标、营销页及移动端商店配置不随 macOS 安装包改名。

## 并行启动核对

```sh
# Linx
vp run dev:server            # 默认 13774
ls -d ~/.linx

# Synara（独立仓库）
# 默认 3773；不得指向 ~/.linx
```

判定：端口不冲突；Home、UserData、Scheme、App ID 均不同；Linx 不读取 Synara 或 T3 Code 目录。

### 实测记录（2026-11-25）

- Linx：`node scripts/dev-runner.ts dev:server --home-dir /tmp/linx-verify --port 3774 --no-seed`，监听 `127.0.0.1:3774`。
- Synara：`SYNARA_HOME=/tmp/synara-verify SYNARA_PORT=3773 SYNARA_NO_BROWSER=1 bun run src/index.ts`，监听 `127.0.0.1:3773`。
- 两个进程同时存活；Linx 写入 `/tmp/linx-verify/userdata`，Synara 写入 `/tmp/synara-verify/userdata`，无交叉目录。
- 结束时停止两个临时进程，未触碰 `~/.linx`、`~/.synara` 或仓库内状态。

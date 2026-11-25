# P1 · 单 Expert Runtime 统一验收

- **验收时间：** 2026-11-25。
- **范围：** P1.1a 存储/快照、P1.1b Launch/Expert Context、P1.2 Composer/绑定和原生 Projection。P1.3、Skill/MCP Gateway、Suite、数据迁移不在本次验收范围。
- **版本：** 上游固定基线 `5b2299ca0a471f1ac9263b0e313f2b4394700d48`；本轮比较基线 `a4c7706bbc9e70fec1852515e6eae9e4d8e32aad`；验收代码 `00f89f1a5745309dc51b3c6049949b181a35349a`，已推送 `linx/integration`。
- **环境：** macOS 27.2.1 / ARM64，Node 26.13.1，Codex CLI 0.170.0，Synara Chromium。Linx 使用独立初始数据目录启动，未导入旧数据；实际启动走 dev 客户端，重启复验走本地构建的静态客户端与同一数据目录。

## 实际浏览器与 Codex 证据

1. 用 `node scripts/linx/launch-expert.ts http://127.0.0.1:18774 --snapshot-only` 在原生 WebSocket 上注册合成 Expert。浏览器在新建草稿的 Composer 选择 `linx-context-verifier · v1 · f513630c` 后发送首条消息，自动进入返回的 Thread，而非草稿保留 ID。
2. 只读对账：`linx.sqlite` 绑定在 `04:59:48.351Z` 建立；`statev2.sqlite` 首个原生 Run 在 `04:59:48.416Z` 请求、`05:00:09.600Z` 完成。Provider 为 `codex`，首轮原生 Projection 有且仅有一个完成的 `t3-code.linx_expert_context` 工具项；工具和最终回复均含与绑定相同的完整 `snapshotId` 和 `contentHash`。
3. 重启静态客户端所连接的服务进程，刷新同一个浏览器标签。恢复原 Header Badge、首轮回复及原生 Composer，无需再次配对。刷新后浏览器日志采样：0 未处理异常、0 `error` 级控制台条目。重启后数据库仍是同一条绑定、同一个首轮 Run、同一条首消息；Outbox 为 `sent`。

| 字段              | 实测值                                                                         |
| ----------------- | ------------------------------------------------------------------------------ |
| Thread ID         | `linx:launch:f1985e24267b406a8e5324abd38a3070b2caf7e36bb44caa9430f00f780b9aa3` |
| Expert / revision | `linx-context-verifier` / `1`                                                  |
| Snapshot ID       | `snap_ccee8e7f52eafcde653e14b963a89910`                                        |
| SHA-256           | `f513630cd7b74c9205f1bfe783c1a2af5cd5d491ddefedb503ded2dd66afb05d`             |

**重启并刷新后的浏览器截图：** `~/.linx/codex-home-overlay/generated_images/browser-proof/b14e1dce5c797b9f9f96f1ab/81cd6b2c-5237-45c8-bcdf-b79a6b0fd7b2.png`（主机本地证据，不在仓库中）。CLI 独立证据见 [P1.1b](p1.1b-evidence.md)。

## AC 对账

| AC    | 证据                                                                                                                                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1  | 两个 SQLite 文件各自存在；`linx.sqlite` 只有 `expert_snapshots`、`linx_migrations`、`linx_outbox`、`thread_expert_bindings`；`statev2.sqlite` 无 Linx 表。`LinxSqlite.test.ts` 验证两个客户端共存，不替换 T3 `SqlClient`。                                |
| P1-2  | RPC 创建、对 `content_json` 复算 SHA-256 一致。快照测试验证同一 revision 的冲突和篡改后拒绝；MCP HTTP 篡改测试无内容返回。资源测试验证路径逃逸、符号链接及内容哈希。无更新快照 RPC。                                                                      |
| P1-3  | Composer 实测、绑定与首轮 T3 时间及 Codex MCP 响应对账见上。`LinxLaunchService.test.ts` 另在启动调用内确认绑定已提交。                                                                                                                                    |
| P1-4  | `ThreadLaunchService.test.ts` 在真实 T3 接受后丢弃响应，并发以原请求重试只产生一个 Thread、一个 Run 和一条首消息；同 key 不同 payload 冲突。浏览器与 client-runtime 测试分别覆盖失败重试和 socket 更换复用 `clientRequestId`；无 Expert 时走原生 launch。 |
| P1-5  | 实际重启、刷新与读取原绑定均通过；两个数据库均无 `t3_event_cursors`，没有 Linx Thread 读模型。                                                                                                                                                            |
| P1-6  | MCP HTTP 验证根 Thread 与两个同父子 Thread 只读各自绑定；未绑定的根、子 Thread 均拒绝；不存在父绑定回退；伪造 `threadId` 被协议拒绝；outside client 的工具列表隐藏且直调失败。RPC scope 测试另覆盖 read/operate。                                         |
| P1-7  | 选择、发送、首轮工具、Badge 与刷新均用真实 Chromium 验证。浏览器回归另覆盖附件入口、失败保留草稿、普通发送、只读 gate 与 Badge 状态。                                                                                                                     |
| P1-8  | 用隔离测试凭据扫描 Linx SQLite/WAL、结构化 trace 和 Linx 启动的原生 Projection（12 条内容，含 Prompt 与 Tool Result），无明文匹配；领域导入边界检查零匹配。原生 T3 配对记录例外见下。                                                                     |
| P1-9  | 定向测试 12 文件 / 155 通过；`check:changed` 27 文件 / 443 通过，React Compiler 9 项通过。工作区 typecheck 43/43，server/web 单独 typecheck、i18n 检查及静态 Web 构建均通过。                                                                             |
| P1-10 | 本报告记录确定版本、环境、实际运行、命令与证据。                                                                                                                                                                                                          |

后续布局调整：新建草稿的 Expert 入口在 Composer 底栏、模型按钮左侧。收起时只显示名称；展开后保留版本和哈希，不显示附件说明。选中 Expert 时仍不接受附件。已绑定 Thread 仍只在 Header 显示冻结绑定。

## 验证命令

```sh
CI=1 vp test run apps/server/src/linx \
  apps/server/src/mcp/toolkits/linx/handlers.test.ts \
  apps/server/src/orchestration-v2/ThreadLaunchService.test.ts \
  apps/server/src/auth/RpcAuthorization.test.ts packages/contracts/src/linx.test.ts \
  packages/client-runtime/src/operations/commands.test.ts --maxWorkers=3
CI=1 vp run check:changed a4c7706bbc9e70fec1852515e6eae9e4d8e32aad
vp run typecheck
(cd apps/server && ../../node_modules/.bin/effect-tsgo tsrs --noEmit)
(cd apps/web && ../../node_modules/.bin/effect-tsgo tsrs --noEmit)
vp run i18n:generate
vp run i18n:check
(cd apps/web && vp build)
rg -n 'orchestration-v2|/mcp/|@t3tools/provider-' apps/server/src/linx/{persistence,expert,thread}
```

## 限制与边界

- 本机 mobile 依赖补齐后 `check:changed` 无失败。原基线整文件运行时快捷键测试受复用连接的旧 Server Config 影响；修复测试服务器发布刷新事件，未修改生产快捷键。
- 开发服务器重启曾触发 Vite 动态模块加载错误；上述生产构建复验无未处理错误，未用开发热重载替代重启证明。
- **P1-8 边界：** 原生 `statev2.sqlite` 的 `auth_pairing_links` 仍按 T3 既有设计保存一次性配对字符串，废弃的记录也不是自动擦除。本次已消费或撤销所有该隔离实例的现场测试配对链接，活动链接为 0；旧 dev 凭据也已停用。P1 未写入该表，不宣称 T3 原生认证库全库无明文历史记录。

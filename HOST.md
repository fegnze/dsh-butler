# Butler Host

`dsh/index.js` 是 `dsh-butler` 的 Host 入口。它注入 DSH App 的 `webServer` 与 `subprocess`，在同一进程内注册 Butler 路由、扫描工作目录并托管扩展物。Host 不启动独立 HTTP 服务，不安装 LaunchAgent，也不维护 Agent/chat/model runtime。

## 配置与工作目录

插件配置只接受 `workdir`；缺省为 `~/.dsh/butler/`。首次加载时，若目录没有 `butler.json`，Host 从包内 `skeleton/` 复制通用骨架，并保留已有文件。工作目录级 [`butler.json`](../../Butler/butler.json) 提供扫描根、`selfRoot`、`validityRoot`（正式卡检查项的解析根，缺省为工作目录）、`python`、`bun`、`notification`、`endpoints` 与 `automations`；相对路径以该文件所在目录为基准。

Host 注入以下通用环境：

- `BUTLER_SELF_ROOT`、`BUTLER_INSTANCE_ROOT`、`BUTLER_STATE_DIR`、`BUTLER_LOG_DIR`
- `BUTLER_SDK_PY`、可选的 `BUTLER_PYTHON` 与 `BUTLER_BUN`
- `BUTLER_HOST_URL`（`BUTLER_GUARDIAN_URL` 只为旧扩展保留）

## 生命周期

`tools/` 中含 `hosted` 的工具由 `Supervisor` 托管；`services/` 中含 `hosted` 的服务由 `ServiceManager` 托管。`autoStart` 项在插件 effect 建立时启动。工具按重启策略恢复，服务只在显式 start/restart 时启动。清单重扫会注册新增项、更新现有项、停止并注销已删除项。

声明了 `mcp` 的扩展物另有一个按需拉起的 stdio MCP 子进程（首个 MCP 请求时启动，常驻复用；重扫后在无进行中调用时重启以读取新代码；扩展物移除或 `mcp` 块变化时立即关闭）。所有子进程都经过 `ctx.subprocess.spawn()`。插件卸载或 DSH App 退出时，effect 先注销路由、停止托管表，再等待 managed range 完成终止；不得在生产 Host 中调用 `node:child_process`。

## 路由

公开路由挂在 `/myspace-butler/api` 同源前缀下，原客户端 `/myspace-butler` 前缀作为兼容别名。以下列出前缀后的相对路径：

| 路径 | 用途 |
| --- | --- |
| `/health`、`/logs` | Host、工具、服务和 Butler 工作目录健康摘要 |
| `/catalog` | 扩展物公开清单；`?rescan=1` 重扫 |
| `/overview` | 工具的运行态与面板动作 |
| `/tools/:id/*`、`/services/:id/*` | 生命周期、动作、打开路径和 SSE 日志 |
| `/faculties/:id/reports/:reportId` | 执行只读 faculty 报告 |
| `/faculties/:id/commands/:commandId` | 执行 faculty 命令；body `{confirmed, args?}`，write/external 需 `confirmed:true`，`args` 只接受清单 `args` 声明的键（否则 400 `invalid_args`） |
| `POST /extensions/tool-dir` | 按目录登记工具：目录内需有 kind=tool 的 `butler.json`；不在 `tools/` 下时以 `tools/<id>` 软链接接入，扫描照常发现 |
| `/operations/*` | 工具与服务的能力目录和生命周期动作 |
| `/quick-actions` | 快捷入口读取、编辑与执行 |
| `/runs`、`/runs/stream`、`/runs/event` | 工作流观测：SDK runner 推送事件，操作台「工作流」区经 SSE 实时显示 |
| `/butler` | `self/`、journal、spool、端点与 digest 的只读视图 |
| `POST /mcp` | Butler 统一 MCP（Streamable HTTP，无状态，JSON 应答）：聚合各扩展 `mcp` 块注册的 stdio 提供方，工具名 `<namespace>__<tool>`；`GET`/`DELETE` 返回 405 |
| `GET /mcp/status` | MCP 提供方状态、对外工具名（含描述首行 `toolDetails`）、命名空间冲突与被拒工具名；`?owner=<kind>:<id>` 只看一个扩展，`?warm=1` 先拉起（有界等待）——操作台「配置」弹层与工具自己的设置页都用它公示 MCP 工具 |
| `POST /mcp` | **Butler 统一 MCP 服务**（Streamable HTTP，无状态，仅 POST；GET/DELETE 返回 405）：聚合所有声明 `mcp` 块的工具/服务，对外工具名 `<namespace>__<tool>` |
| `GET /mcp/status` | 各 MCP 提供方的状态、命名空间冲突与被拒工具名 |

公开 catalog/operations 不暴露执行命令和环境变量；服务状态与本机配置编辑接口提供命令及工作目录，故整个 API 仅供受信本机调用，不得作为未鉴权远程 API 暴露。写操作接受同源浏览器请求和 loopback SDK 请求，拒绝跨站请求。工具日志回放最多200条，每条最多8192字符，退出时关闭订阅。

## MCP 统一服务

分层：**Framework 定标准**（`spec/butler.schema.json` 的 `mcp` 块，`src/host/mcp-decl.ts` 同口径校验）→ **Butler Host 统一对外**（`mcp-hub.ts` + `mcp-stdio.ts`）→ **工具只实现 stdio MCP**，不自行监听、不直接接入客户端。

- 提供方：`tools/`、`services/` 中声明 `mcp: {transport:"stdio", command[], cwd?, env?, namespace?, timeoutSec?}` 的清单；faculty 不得声明。注册表由 catalog 扫描派生，无第二份登记。
- 拉起：首次请求时经 `ctx.subprocess.spawn()`（`stdin:'pipe'`）懒启动，env 注入 `BUTLER_MCP_CHANNEL=butler-hub`；工具可据此拒绝被客户端直接拉起。冷启动等待上限 8s，崩溃后 5s 退避重启。
- 命名：命名空间默认取工具 id（`-`→`_`），冲突时双方都不暴露并在 `/mcp/status` 报告；不合 `^[A-Za-z0-9_-]{1,64}$` 的对外名被拒。
- 调用：超时默认 600s（上限 3600s），超时返回 `isError` 结果并向提供方发 `notifications/cancelled`；提供方 `instructions` 合并进 Butler 的 `initialize`。
- 生命周期：清单重扫时增删提供方；Host 退出时先关闭全部 MCP 子进程。
- 安全：与其余 API 同一 `trustedRequest()`（仅 loopback、拒跨站），兼作 DNS rebinding 防护。

客户端接入（以 Codex 为例）：

```toml
[mcp_servers.butler]
url = "http://127.0.0.1:19387/myspace-butler/api/mcp"
```

## 开发检查

```sh
cd /Users/ghost/MySpace/dsh-plugins/dsh-butler
/Users/ghost/MySpace/.venv/bin/python build.py
bun test
bun test contract.test.ts
bun run typecheck
```

构建会更新 `dsh/client.js` 与 `dsh/host.js`；它们是发布包内容，不要手工编辑。安装与 desktop profile 验收见 [`README.md`](README.md) 和 [`../../Plan/butler-dsh-plugin/README.md`](../../Plan/butler-dsh-plugin/README.md)。

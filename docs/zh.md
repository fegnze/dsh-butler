# dsh-butler

[English](<../README.md>) | 中文

`dsh-butler` 是 DSH App 的 Butler 插件：浏览器界面和本地 host 同包发布。host 通过 DSH 的 `webServer` 与 `subprocess` 服务注册路由、扫描扩展物并托管进程；不启动独立 Guardian，不安装 LaunchAgent，也不依赖 Nowledge Mem。

## 工作目录

插件配置支持 `workdir`，未配置时使用 `~/.dsh/butler/`。首次加载时会复制插件内置的通用 skeleton；已存在 `butler.json` 的目录不会被覆盖。个人数据、解释器配置和扩展物属于实例工作目录，可整体迁移；插件不预设个人工作区。

工作目录根配置示例：

```json
{
  "scanRoots": ["tools", "services", "faculties"],
  "selfRoot": "self",
  "validityRoot": ".",
  "python": "/path/to/python",
  "bun": "/opt/homebrew/bin/bun",
  "notification": {
    "enabled": true,
    "command": ["bun", "notification-bridge/scripts/cli.js", "send", "--stdin"]
  },
  "endpoints": {},
  "collector": { "enabled": true, "workspaces": [], "excludePresets": ["butler"], "debounceMs": 2000 },
  "automations": {}
}
```

相对路径均以 `butler.json` 所在目录为基准。`tools/` 与 `services/` 中的 `hosted.autoStart` 扩展物随 DSH App 启动恢复；App 退出或插件卸载时由 DSH subprocess managed range 终止。服务不自动重启，工具按清单策略在 host 内重启。`faculties/` 的有限命令和报告也通过同一 subprocess 接缝执行。

## Host API

公开 Host API 统一挂在 DSH 同源前缀 `/myspace-butler/api` 下；原客户端 `/myspace-butler/*` 路径保留为兼容别名。包括 `/health`、`/catalog`、`/services`、`/faculties`、`/runs` 与 `/quick-actions`；工具列表从 `/overview` 获取。工具与服务均支持 `/:kind/:id/{start,stop,restart}` 和 `/:kind/:id/log` SSE。请求只接受本机同源浏览器流量或本机 SDK 请求；公开扩展目录不包含命令和环境变量，配置编辑接口仅供受信本机调用。完整路径见 [HOST.md](../HOST.md)。

扩展物使用每个目录的 `butler.json`，完整字段见 [`spec/butler.schema.json`](../spec/butler.schema.json)。SDK runner 使用 `BUTLER_HOST_URL` 发送事件；`BUTLER_GUARDIAN_URL` 只作为兼容旧扩展的别名，不是新的配置入口。

**委托（delegations）**：tool / service 可在清单里声明需要判断的步骤，由 Host 交给新开的 Butler Session 完成（`POST /delegations`，阻塞到会话提交、超时或失败）。Host 是唯一驱动会话的地方：用 `sessionController.create` 建 butler 预设会话、以委托 id 作 requestId 调 `prompt` 投递、超时调 `cancel`。会话只能用声明的工具与 `butler_delegation_submit`，结果按声明的 schema 校验。`risk: confirm` 的结果在观测区挂待确认，`POST /runs/:runId/steps/:i/confirm` 走与卡片审核相同的主人专属门（`X-Butler-Review` + 同源 Origin 或已认证桌面转发）。DSH 不提供 `sessionController.prompt` 时 `/delegations` 返回 503，调用方走自己的 fallback。用法见 [sdk/README.md](../sdk/README.md)。

## 统一 MCP 服务（Butler Framework MCP 标准）

三层分工，彼此只靠「清单 + MCP 协议」相连：

| 层                                    | 职责                                                                                                                                                               | 不做什么                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Framework（`spec/butler.schema.json`） | 定义 `mcp` 注册块：`transport: "stdio"`、`command`、可选 `cwd/env/namespace/timeoutSec`；仅 tool / service                                                                   | 不允许 `http`/`url` 等自对外形态                                              |
| Host（`src/host/mcp-hub.ts`）          | 从扫描结果派生提供方（无第二份登记表）；按需经 `Spawner` 拉起 stdio 子进程；以 `<namespace>__<tool>` 聚合；在 `/myspace-butler/api/mcp` 提供无状态 Streamable HTTP；重扫时增删、空闲时重启；App 退出随 managed range 终止 | 不 import 扩展代码，不理解业务参数                                                |
| 扩展物                                  | 实现一个 stdio MCP server                                                                                                                                            | 不监听 MCP 端口、不调用 Host 内部接口；可凭 `BUTLER_MCP_CHANNEL=butler-hub` 拒绝被客户端直连 |

客户端只配一个地址：`http://127.0.0.1:19387/myspace-butler/api/mcp`（desktop profile 的 App 端口）。`GET /api/mcp/status` 查看提供方状态、对外工具名、命名空间冲突与被拒工具名。命名空间缺省为 id 中 `-` 换成 `_`；对外名须满足 `^[A-Za-z0-9_-]{1,64}$`，不满足的工具不对外并列在 status 里。提供方崩溃只影响自己（调用返回 `isError` 结果，5 秒后重试拉起），不影响其他提供方。安全边界同其余 Host API：仅 loopback，拒绝跨站 Origin（即 MCP 规范要求的 DNS rebinding 防护）。

**统一 MCP 服务**：Butler 体系内的工具/服务若要提供 MCP，只在清单里声明 `mcp` 块（`transport:"stdio"` + `command`），由 Host 懒启动并聚合，经 `POST /myspace-butler/api/mcp`（Streamable HTTP）统一对外，工具名为 `<namespace>__<tool>`；**工具本身不得对外监听 MCP，也不直接注册给任何客户端**。Host 不 import 工具代码，工具只依赖 stdio MCP 与 `BUTLER_MCP_CHANNEL` 环境标记——两侧仅靠清单契约相连。客户端只需登记一个端点 `http://127.0.0.1:19387/myspace-butler/api/mcp`；状态见 `/api/mcp/status`。细节见 [HOST.md](../HOST.md#mcp-统一服务)。

## 操作台显示偏好

服务、工具分别保存「显示全部 / 显示常驻」模式。标题箭头切换显示范围，不折叠整个板块。「显示管理 · 已收纳 N」合并为一个入口，抽屉列出全部项目，可勾选常驻、直接操作项目，并用保存 / 取消提交或放弃显示修改；卡片菜单也可逐项收纳或设为常驻。

收纳只由手动选择决定，不根据 autoStart、运行状态或使用频率推导，也不会修改清单或启停进程。新登记项目默认常驻。搜索始终覆盖全部项目的名称、id 和描述，命中的收纳项带标记；清除搜索恢复原模式。部分项目隐藏或搜索时关闭排序，显示全部后可排序。

偏好沿用 Host `layout.json`（version 1，新增可选 `display.services/tools: { mode: 'all' | 'resident', stored: string[] }`），兼容旧文件；页面与侧栏共享，刷新后保留。「复位顺序」只清除 `order`，不影响显示偏好。保存失败回滚显示并保留抽屉草稿，较早的轮询结果不会覆盖刚保存的设置。

## 开发与验证

完整测试集包含维护者工作区 fixture、历史 Git 对象和桌面集成检查，不是独立安装的冒烟测试。构建后的可移植 CI 切片为 `bun test ./tests/build-launcher.test.ts ./tests/record-ref.test.ts ./tests/pipeline-agent-tools.test.ts`；该切片通过不代表完整测试集或真实桌面验收通过。

```sh
# 需要 Node、Bun 和 Python 3.10+
npm run build
bun test
bun test contract.test.ts
bun run typecheck
```

`dsh/host.js` 和 `dsh/client.js` 是构建后随包发布的产物；改动 host 或 UI 后重新运行 `npm run build`。构建启动器依次选择 `BUTLER_PYTHON`（单个解释器路径或命令名）、从插件目录向上找到的最近 `.venv`、PATH 中的 Python 3.10+。显式配置或虚拟环境无效时直接报错，不回退系统解释器。可用 `BUTLER_PYTHON=/path/to/venv/bin/python npm run build` 指定解释器。安装说明见下节。历史 Plan 验收记录仅保存在维护者本地工作区，不随仓库或 npm 包发布。

客户端动态样式在插入 DOM 前标注 `data-plugin="myspace-butler-panel"`；`data-plugin-css` 只标识样式，不能代替归属。DSH 会将未标注归属的样式认领给随后加载的插件，导致停用或热更新 Aqua 等插件时误删工作台样式。样式仍由各自 effect 负责卸载。

## DSH App 安装

只安装到 desktop profile；本地开发可安装为 `link:/path/to/dsh-butler`。**当前 CLI 拒绝管理 desktop profile**，不要执行旧计划中的 `dsh plugin --profile desktop add`。使用 App 插件管理界面，或退出 App 后用其内置 pnpm 修改依赖：

```sh
# 使用与 App 配套的 Node/pnpm，避免 nvm pnpm 的 store 版本不匹配。
# 将 link 路径替换为自己的 checkout；App runtime 路径以实际安装为准。
ELECTRON_RUN_AS_NODE=1 \
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --expose-internals \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.mjs" \
  --dir "$HOME/.dsh/profiles/desktop" add \
  'dsh-butler@link:/path/to/dsh-butler' \
  --config.minimum-release-age=1440
```

手装还须在 desktop `package.json` 的 `dsh.profile.bundles` 登记 `dsh-butler`；在 `cordis.patch.yml` 配置：

```yaml
- id: butler-panel
  config:
    workdir: /path/to/butler-instance
```

若 pnpm 报 minimum release age，检查排除列表是否有重复包名遮蔽，不全局关闭校验。Host bundle 改动后需完整退出重开 App；单纯刷新网页不会重新加载 Node 模块。验收应检查新 API、逐项启停、退出后的进程与监听端口、重开后的 autoStart 项，不能只凭 link 已存在或测试通过。

插件 checkout 与实例工作目录应分开存放；在大小写不敏感的文件系统上，不要仅靠目录名大小写区分二者。

## 卡片闭环重设计（实施中）

新的核心链路为：会话证据 → 完整候选卡 → 人工审核 → Markdown Wiki → Agent 搜索读取。重设计方案与实施记录属于维护者本地 Plan 文档，不随公开仓库或 npm 包发布。历史个人数据不因升级源码自动迁移；迁移先 dry-run。下面 M1–M4 段落是旧链路说明，尚未完成的切换不得据此视为已上线。

新界面默认进入待确认，卡库与会话分区；运行与设置保留旧维护能力。新同源 `/myspace-butler/api/pipeline` 路由由 DSH Host 调 faculty 命令，不另起服务；普通模型工具不暴露批准动作。

协议是 `POST {action,args}`，返回 `{ok:true,data}` 或 `{ok:false,error:{code,message}}`。审核先 `review.prepare` 获取短时令牌，再提交同一候选 `id/revision/contentHash` 与 `idempotencyKey`；必须有明确同源 Origin、Sec-Fetch-Site 与 `X-Butler-Review: 1`。UI不自动重试批准。正文和哈希原样传递，只剥除run/lease令牌字段；凭证在采集时脱敏。

正式卡有效性：审批状态（`status` active/archived，只随人工批准变化）与有效性（`valid`/`suspended`）分离。有效性存于 `self/validity/<id>.json`，绑定卡片 `revision+contentHash`，不改卡文件，因此不会触发注入重放。检查项只有两种确定性类型：`path`（相对 `validityRoot` 的文件存在）与 `quote`（文件仍含该原文，空白归一）；`validityRoot` 缺省为工作目录，经 `BUTLER_VALIDITY_ROOT` 传给 faculty，拒绝绝对路径、`..` 与越界符号链接。检查在读卡、检索和 `distill.claim` 时刷新，结论不变不写盘；失败自动暂停，依据恢复自动恢复，根目录不可用时保留上次结论。蒸馏候选可带 `checks`（批准后生效，提交时须已通过；profile 卡不收）和 `conflict`（仅 revise/archive；提交即暂停目标卡，主人拒绝该候选或批准修订后解除）。既有卡的检查项由运维命令 `validity.set-checks` 设置（仅 faculty 命令行，需当前 revision），`validity.refresh` 全量刷新。`scope` 只表示可见范围（默认 `local`），适用场景写 `appliesTo`；旧卡的自由文本 scope 读出时自动转为 `appliesTo`。

统一消费判定在 faculty：`cards.search`/`cards.read` 默认只返回 active 且未暂停的卡，暂停或归档卡读取返回 `card_unavailable`；注入、`butler_search/read` 与 `card` 命令都经此判定，consumer 工具另做一层兜底过滤。只有卡库 UI 经 HTTP 传 `includeInactive` 查看归档与暂停卡；模型工具 schema 不含该参数，传入即被拒。检索只匹配标题、摘要、适用范围、标签与正文，不匹配证据和元数据。

Agent 消费边界：自动注入仅包含已批准卡的标题、摘要和版本索引；`butler_search` 返回核心索引字段，不返回正文；`butler_read` 按需返回核心正文与关联卡 ID。证据、审核理由、哈希、内部路径与决策元数据只留管理端，不随消费工具返回。卡片正文应保持当前有效内容，不用历史证据充当核心正文。

普通 Agent 能力由根级 `dsh-butler/consumer` 插件注册 `butler_search`、`butler_read`、`butler_report_session`，不安装工具限制器；DSH 根工具可由各 preset 继承，preset 自身的限制仍生效。Consumer仅使用Host已发布的工作目录，解释器必须由实例 `python` 配置。受限 Butler 预设额外提供领取批次、读证据、提交候选与完成批次工具。

实例原有faculty是独立文件副本，更新源码不会自动更新实例。`deploy-faculty.py --workdir <instance>` 默认只输出部署dry-run，`--apply`才写入已校验的pipeline模块及旧写保护、读取切换命令；旧命令仅允许匹配固定仓库基线或此前部署清单的版本升级，个人改版会拒绝覆盖。旧数据仍以显式存储marker为切换点：未激活Wiki时新正式卡读/审核返回`store_not_active`，不是成功空库；会话和候选草稿仍可保存。迁移工具与崩溃恢复正在验收，真实实例尚未切换。

采集器保存每个回合的脱敏消息而不是200字标记；长消息/工具结果截断会标partial。脱敏片段先原子保存到stateDir/collector-pending，收到明确JSON成功回执后删除；失败保留并在启动或flush时重放，正常卸载先flush再关闭子进程。持久化失败或容量超限会告警，不宣称采集完成。构建与测试通过不等同App重启后运行验收通过。

## Session Collector（M1，旧链路）

host 订阅 DSH `session/event`，只处理 `turn/end`。按 `session.header.id` 去抖 `collector.debounceMs` 后，从 `session.snapshotEvents()` 截取当前回合（从对应 `turn/start` 到 `turn/end`），派生一条 `type=session` 观察并调用 journal 的 `intake --source dsh --ref dsh://<session>#<turn>` 写入 spool：

- 文本：本回合首条 `source.kind === 'user'` 的 `user/message`，截 200 字；`agent.inject()` 插件上下文不计入。
- `toolsUsed`：`tool/call.name`；`filesTouched`：`tool/call.arguments` 中的 `file_path`/`path`；`gitCommits`：`tool/result` 文本里的 `[branch sha]`。
- `failed`：`tool/result` 带 `error` 或 `isError`，或 `turn/end.reason.kind === 'error'`。
- 过滤：`header.agentPreset` 命中 `excludePresets`（默认 `butler`，防自采集回环）或 `header.cwd` 不在非空 `workspaces` 内时跳过；`header.origin === 'subagent'` 的委派会话默认跳过（由父会话回合覆盖，`collector.includeSubagents: true` 可开启）。

Collector 不直接写 `self/`；`snapshotEvents` 不可用或 intake 失败都以 `[butler] collector:` 警告写入 App 日志，不抛进 DSH 事件链。Host bundle 改动后须完整重启 App 才生效。

### `POST /api/observe`

外部探针（端点 hook、脚本）上报一条观察，body `{source, type?, tags?, text, ref?}`：`source` 为 `[a-z0-9-]`；`type` ∈ `note|decision|fact|milestone|error|session`（默认 `note`）；`text` 1–2000 字；`tags` 为不含逗号/控制字符的字符串数组（≤32）；`ref` ≤500 字。成功 202 `{queued:true}`；校验失败 400 `invalid_observation`；intake 失败 502 `intake_failed`；跨站请求 403。只追加 spool，不直接写 journal。

### L0 硬观察

Host 自己目睹的事实同样经 `intake --source butler` 进 spool，`ref` 为 `butler://<subject>`：工具意外退出（`type=error`，`tool:<id>`，含退出码与下次重启间隔）、服务崩溃（`type=error`，`service:<id>`）、重扫描新增/移除扩展（`type=note`，`catalog:<id>`）。手动停止、重启与启动时的首次扫描不记录；观察失败只写 App 日志，不影响托管。

桌面 App 是 Butler 的唯一运行载体：App 没启动时不托管扩展物，App 退出后不应留下 Butler 子进程。

## 上下文注入（M3）

- 沉淀物是一卡一文件：规则卡 `self/rules/<slug>.md`（主人认可的工作约定，与根规则冲突时以根规则为准）、知识卡 `self/knowledge/<slug>.md`。
- `journal/bin/build-context` 把主人画像与卡片索引（每卡一行：id、标题、摘要）编译成 `self/build/context.md`，默认上限 8000 字，画像不截断，卡片正文不进上下文。`run`、成功的 `apply` 和 `migrate-rules` 会自动重编。
- Agent 按需读卡：普通会话运行 `card <id>`（索引里给出完整命令），Butler 会话用 `butler_card`。
- Host 在同一个 `ctx.effect` 里注册 `agent/pre-step`（`prepend`）。每个符合条件的会话注入一次：插件 snapshot 用户消息，`source.kind = plugin:myspace-butler-panel`，section 为 `butler-context`。去重看模型可见面 `session.deriveMessages()`，压缩丢掉后会补注一次。
- 根 `butler.json` 的 `inject` 控制：`enabled`、`workspaces`、`excludePresets`（默认 `["butler"]`）、`includeSubagents`、`maxChars`。消息按 `@deepseek-ai/dsh-llm` `createUserMessage` 的同一形状在本地构造。插件以软链接装入 profile，无法解析 App 自带的包；导入它会导致整个插件加载失败（真机已验证）。

## M4 决定


- WorkBuddy 与 git 端点已在 M1B 实现，见 journal faculty README 的 External endpoints。
- `nowledge-bridge` 延期：等 knowledge 累积后再以 faculty 命令立项，不另起常驻工具。
- 清单 `flows[]` 与动作 `mode: "flow"` 已删除。多步流程由工具自己用 `sdk/` runner 实现，经普通动作触发。历史理由与真机验收记录保存在维护者本地 Plan handoff 文档，不随公开包发布。

## butler 预设（M2）

插件 bundle patch（`cordis.patch.yml`）声明受限预设 `butler`。只有该预设挂载子导出 `dsh-butler/agent`（`dsh/agent.js` → 构建产物 `dsh/agent-host.js`），其中蒸馏与旧兼容工具只在 butler 会话可见；根级 consumer 独立注册 `butler_search/read/report_session`，普通会话无需挂载管家 persona：

| 工具                       | 背后命令                                        |
| ------------------------ | ------------------------------------------- |
| `butler_journal_read`    | `distill --json`（只读；只给观察记录，Git 提交与会话回合不在其中） |
| `butler_distill_advance` | `distill --advance`                         |
| `butler_candidate`       | `memory candidate-mark`（只打「建议升级」标记）         |

- 预设另只含 `dsh-persona`、只读 `dsh-tool-fs-search` 与 `dsh-tool-ask-user`。不含 bash、`dsh-tool-fs`（自带写入）、web、委派或 cordis 编辑。
- 没有写卡、改资料的工具：模型只能给观察记录打「建议升级」标记，升级由主人在记忆页确认（Host 确认命令）。
- 工具参数按声明白名单校验，校验失败不启动子进程；命令经 DSH `subprocess` 接缝执行。
- agent 半边在每次工具调用时读取 Host 已发布的工作目录（进程内 `Symbol.for('myspace-butler.workdir')`）。它不初始化实例，也不回退到默认 `~/.dsh/butler`：Host 未挂载时工具直接报错。
- agent 半边注册 agent 作用域的 `tools.guard`：只允许 `butler_*`、glob、grep、ask_user_question 执行，团队、调度、记忆写入等宿主级工具调用一律拒绝。不用 `tools.restrict`，因为预设各行的工具注册在祖先层，restrict 会把它们一起隐藏（真机已验证）。
- 预设锁定于会话首回合：新建会话时选择 Butler 预设，或在空会话中切换。

### 自动化任务（插件代建）

简报页「自动化任务 → 登记」调用 Host `POST /automations`，在 DSH 自动化任务中登记 1 个 cron 任务（蒸馏），时区 `Asia/Shanghai`，并清掉已退役的日报/周报/周检任务。任务定义和提示词以 `src/host/automations.ts` 为准，随插件版本维护。

| 标题          | 规则    | 做什么                                                                                              |
| ----------- | ----- | ------------------------------------------------------------------------------------------------ |
| 蒸馏 · Butler | 每小时整点 | `butler_distill_claim` → 检索正式卡 → `butler_candidate_submit` 完整候选 → `butler_distill_complete` 确认覆盖 |

新版定义仅在重新登记后替换实际任务；只改源码不会自动修改已安装任务。完整参数以工具声明为准，零候选必须说明原因，处理失败不得确认覆盖。

- DSH 任务绑定会话，到点后把提示词投递到该会话。任务运行在实例根目录新建的 `butler` 预设会话里，会话经 `workspaceRegistry` 挂入 Butler 工作区（`session.create` 只给 `cwd` 会得到不属于任何工作区的游离会话）；已有的游离任务会话在登记时补挂入工作区，找不到该服务则退回按目录创建，因此只能使用 butler\_* 工具。会话变长时由 DSH 自动压缩。
- 按标题幂等：内容一致的保留；提示词或规则有变化的删除重建；不带 `· Butler` 后缀的任务不碰。重复点击是安全的。
- 日报、周报、周检已退役：简报页的「最近动态」实时给出同样的事实，不再另写一份报告。登记时按旧标题（`日报/周报/周检 · Butler`）删除已装的旧任务；`self/digests/` 里已有的报告原样保留。
- `schedule`/`sessionController` 是可选的 App 服务。Host 通过 `ctx.get` 按请求读取，不写进 `inject`，因为 cordis 会把 inject 里的每一项都视为必需。未启用 `dsh-experimental-schedule-bundle` 时，路由返回 503，Butler 其余功能照常。

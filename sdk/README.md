# Butler SDK 工作流编排规范

本 SDK 为 Butler 工作目录中的 tool、service 和 faculty 提供可观测、可重试、幂等的多步骤 runner。权威实现位于 `sdk/ts/runner.ts` 与 `sdk/py/butler_sdk.py`。

| 语言 | 入口 | 引入方式 |
| --- | --- | --- |
| TS/Bun | `ts/runner.ts` | 从当前插件仓库的 `sdk/ts/runner.ts` 引入 `runWorkflow` |
| Python | `py/butler_sdk.py` | 将 `BUTLER_SDK_PY` 加入 `sys.path` 后引入 `Workflow` |

Host 向扩展注入 `BUTLER_HOST_URL`；runner 将事件发送到 `${BUTLER_HOST_URL}/runs/event`。`BUTLER_GUARDIAN_URL` 仅为旧扩展兼容保留。事件发送是 fire-and-forget，不得改变主流程成败。

## 何时使用

- 一个动作有两个或更多用户可感知步骤时使用 runner。
- 需要重试、运行观测或留痕时使用 runner。
- 单步、瞬时且没有观测价值的函数不必套 runner。

## Step 设计

一个 step 是用户能理解、整体成功或整体失败的产出单元。按阶段或文档粒度拆分；不要把每次 HTTP 调用拆成噪音，也不要把整条流程塞进一个无法定位失败的 step。跨 step 数据放入 `ctx.state`。每个 step 必须幂等、可重试、可覆盖执行。

默认一个 workflow 内串行执行；没有共享可变目标且目标独立时，拆成多个 workflow 并用 `Promise.allSettled`，让各自 runId 独立观测。受外部限流时设置并发上限。

## 失败与观测

- 强顺序 workflow：step 重试后仍失败，后续 step 标记为 `skipped`，workflow 为 `error`。
- 批量 step：声明 `continueOnError` 后继续处理其他项，最终汇总失败项并将 workflow 标为 `error`。
- 每个 workflow 必须提供稳定 `name`、展示用 `title` 与触发 `source`（如 `cli`、`mcp`、`automation`）。
- 向 DSH App 的 `/myspace-butler/runs/event` 发送紧凑事件；不要把整篇文档或块 JSON 回灌 Agent 上下文。
- 运行事件由 Butler Host 的内存观测区消费；通知由工作目录的 `notification` 配置决定。

## 委托给 Butler 会话：agentStep

规则能定的步骤照常写；**需要判断的那一步**（死链该指向哪、构建失败原因是什么）可以用 `agentStep` 交给一个新开的 Butler Session。会话只出方案，采纳与写入始终由调用方代码执行。

1. 在扩展物的 `butler.json` 声明 `delegations[]`：`id`、`instructions`、`result`（JSON schema 子集）、`risk`（`auto` 直接采纳 / `confirm` 主人在观测区确认）、可选 `tools`（默认 `glob`、`grep`，只读）与 `timeoutSec`（10–1800，默认 300）。
2. 在 step 里调用：

```ts
import { agentStep } from '../sdk/ts/agent-step.ts'

const outcome = await agentStep(ctx, {
  delegation: 'my-tool/fix-dead-links',          // <extensionId>/<delegationId>
  input: { deadLinks },
  summarize: (plan) => ({ summary: `${plan.fixes.length} 条修正`, items: plan.fixes.map((f) => `${f.from} → ${f.to}`) }),
  fallback: () => null,                            // 委托不可用 / 超时 / 被拒绝时的静态行为
})
if (outcome.source === 'delegated') apply(outcome.value)
```

- 每次调用新开一个 butler 预设会话；观测区的步骤上有「打开会话」链接，可回看完整过程。
- 会话内只放行声明的工具和提交工具 `butler_delegation_submit`；结果按声明的 schema 校验，不合格会退回让会话改正。
- `confirm` 级在观测区挂「待确认」，批准 / 拒绝只能由主人的 UI 发出（与卡片审核同一道门），SDK 进程只能轮询读取。
- **必须提供 `fallback`**：DSH 不支持插件驱动会话、Host 不在、超时或被拒绝时都走它，流程不会因此卡死。

## 经 Butler 提供 MCP

工具不自己对外提供 MCP。做法：

1. 实现一个 **stdio MCP 服务**（任意语言/SDK，按行 JSON-RPC；stdout 只写协议消息，日志写 stderr，非 JSON 行会被忽略）。
2. 在 `butler.json` 声明：

   ```json
   "mcp": { "transport": "stdio", "command": ["bun", "src/cli.ts", "mcp"], "namespace": "feishu", "timeoutSec": 1800 }
   ```

   `namespace` 可省（默认取 id，`-`→`_`）；对外工具名为 `<namespace>__<tool>`，工具名本身只用 `[A-Za-z0-9_-]`。
3. 建议在入口检查 `BUTLER_MCP_CHANNEL === "butler-hub"`，否则拒绝启动并提示走 Butler 端点——防止被客户端绕过 Butler 直连。
4. 可在 `initialize` 返回 `instructions`，Butler 会合并给客户端；长任务按需调大 `timeoutSec`（上限 3600）。

不需要 import 任何 Butler 代码，也不需要改客户端配置；清单重扫后即生效，`GET /api/mcp/status` 可查是否就绪。

## Python 服务

Python 扩展使用同目录的 `emit.py`，只依赖标准库，遵守同一 `/runs/event` 事件契约。通过 `BUTLER_HOST_URL` 发现 Host，不要硬编码端口或启动第二个观测服务。

## 最小示例

```ts
import { runWorkflow, type StepDef } from '../sdk/ts/runner.ts'

const docs = await resolve(target)
const steps: StepDef[] = [
  { name: `解析目标（${docs.length} 篇）`, run: async () => {
    if (!docs.length) throw new Error('空目标')
  } },
  ...docs.map((doc): StepDef => ({
    name: doc.title,
    retry: 1,
    retryDelayMs: 1000,
    run: async () => { await syncOne(doc) },
  })),
]
const result = await runWorkflow(
  { name: 'my-flow', title: '我的流程', steps },
  { source: 'cli', target },
)
```

需要独立结果时：

```ts
await Promise.allSettled([
  runFlowA(link, { source: 'cli' }),
  runFlowB(link, { source: 'cli' }),
])
```

## 提供 MCP 工具（不需要 SDK）

扩展物要让外部 Agent 用上自己的能力，就在 `butler.json` 写 `mcp` 块，实现一个**标准 stdio MCP server**（任何语言、任何 MCP SDK 均可），不需要也不应该引用 Butler SDK：

```json
"mcp": { "transport": "stdio", "command": ["bun", "src/cli.ts", "mcp"], "namespace": "feishu" }
```

Butler Host 负责拉起、聚合并在 `/myspace-butler/api/mcp` 统一对外；扩展物自己不得再对外监听 MCP。完整约定见 [README 的「统一 MCP 服务」](../README.md)。

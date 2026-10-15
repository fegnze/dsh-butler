/**
 * The `butler.json` guide shown from the "添加工具" dialog.
 *
 * Adding a tool is pointing at a directory, so everything the tool needs has
 * to be declared in that directory's `butler.json`. This is the owner-facing
 * reading of spec/butler.schema.json for kind=tool, plus the conventions the
 * Host applies (interpreter substitution, path resolution, environment). Keep
 * it in step with the schema and catalog.ts when either changes;
 * contract.test.ts pins the field tables (tool-manifest-fields.ts) against the schema.
 *
 * Chinese only, like the rest of the owner-facing copy: the content is a
 * reference card, not interface chrome.
 */

import { ACTION_FIELDS, HOSTED_FIELDS, TOOL_FIELDS } from './tool-manifest-fields.ts'

const MINIMAL = `{
  "schemaVersion": 1,
  "kind": "tool",
  "id": "my-tool",
  "name": "我的工具"
}`

const FULL = `{
  "schemaVersion": 1,
  "kind": "tool",
  "id": "lan-drop",
  "name": "局域网中转站",
  "description": "同网段设备浏览器直达收发",
  "hosted": {
    "command": ["bun", "src/cli.ts", "serve"],
    "port": 8787,
    "autoStart": true
  },
  "health": { "url": "http://127.0.0.1:8787/health" },
  "panelUrl": "http://127.0.0.1:8787/admin",
  "panelSize": { "width": 960, "height": 640 },
  "actions": [
    { "label": "打开页面", "url": "http://127.0.0.1:8787/", "mode": "external" },
    { "label": "立即同步", "url": "http://127.0.0.1:8787/sync", "mode": "post" }
  ]
}`

function FieldTable({ rows }: { rows: readonly (readonly [string, string, string])[] }) {
  return (
    <table className="bp-guide__table">
      <tbody>
        {rows.map(([field, need, text]) => (
          <tr key={field}>
            <td><code>{field}</code></td>
            <td className="bp-guide__need" data-required={need === '必填' ? 'true' : undefined}>{need}</td>
            <td>{text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The guide body.
 * @returns the guide element.
 */
export function ToolManifestGuide() {
  return (
    <div className="bp-guide">
      <h3>登记方式</h3>
      <ul>
        <li>工具 = 一个目录 + 目录根上的 <code>butler.json</code>。登记只是让扫描看见它，不复制、不改写文件。</li>
        <li>目录已在 <code>Butler/tools/</code> 下：直接重扫出现。在别处：以 <code>tools/&lt;id&gt;</code> 软链接接入，源文件留在原处。</li>
        <li>之后改了 <code>butler.json</code>，再登记一次同一目录即会重扫（幂等）；要撤销登记，删掉 <code>tools/&lt;id&gt;</code> 这个链接即可。</li>
        <li>同 id 已存在时拒绝登记，不会覆盖。</li>
      </ul>

      <h3>最小示例</h3>
      <pre className="bp-guide__code">{MINIMAL}</pre>

      <h3>顶层字段</h3>
      <FieldTable rows={TOOL_FIELDS} />

      <h3><code>hosted</code>：常驻进程</h3>
      <FieldTable rows={HOSTED_FIELDS} />
      <ul>
        <li>命令首项写 <code>python</code> 会替换为工作目录 butler.json 里配置的 python 解释器，写 <code>bun</code> 用配置的 bun；其他首项含 <code>/</code> 时按 butler.json 所在目录解析。</li>
        <li>以 <code>./</code> 或 <code>../</code> 开头的参数同样按 butler.json 所在目录解析。</li>
        <li>进程由 DSH App 内的 Butler Host 托管，随 App 退出而结束；不要自带 LaunchAgent 或常驻脚本。</li>
        <li>进程会拿到 <code>BUTLER_HOST_URL</code>、<code>BUTLER_INSTANCE_ROOT</code>、<code>BUTLER_SELF_ROOT</code>、<code>BUTLER_STATE_DIR</code>、<code>BUTLER_LOG_DIR</code>、<code>BUTLER_PYTHON</code>、<code>BUTLER_BUN</code>、<code>BUTLER_SDK_PY</code> 等环境变量。</li>
      </ul>

      <h3><code>actions[]</code>：卡片按钮</h3>
      <FieldTable rows={ACTION_FIELDS} />
      <p>多步骤动作（有重试、要观测进度）不要拆成多个按钮：用一个 <code>post</code> 动作触发，工具内部用 Butler SDK runner 分步执行，步骤会实时出现在操作台「工作流」区。</p>

      <h3>完整示例</h3>
      <pre className="bp-guide__code">{FULL}</pre>

      <h3>常见被拒原因</h3>
      <ul>
        <li>没有 butler.json，或不是合法 JSON。</li>
        <li><code>schemaVersion</code> 不是 1、<code>kind</code> 不是 tool、<code>id</code> 含大写/下划线/斜杠、缺 <code>name</code>。</li>
        <li><code>hosted</code> 存在但 <code>command</code> 为空。</li>
        <li><code>id</code> 与已有工具重复。</li>
      </ul>
    </div>
  )
}

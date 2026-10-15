/**
 * Field tables for the butler.json guide (kind=tool). Plain data so the
 * contract test can check them against spec/butler.schema.json without React.
 */

/** Top-level fields, in the order an author writes them. */
export const TOOL_FIELDS = [
  ['schemaVersion', '必填', '固定为 1。'],
  ['kind', '必填', '固定为 "tool"。（"service" 是只托管的外部进程，"faculty" 是 Butler 本体机能，都不走这个入口。）'],
  ['id', '必填', '小写字母、数字、连字符，以字母或数字开头；全局唯一，建议与目录名一致。目录不在 tools/ 下时，会以 tools/<id> 软链接登记。'],
  ['name', '必填', '卡片上的展示名。'],
  ['description', '可选', '卡片第二行的说明。'],
  ['icon', '可选', '卡片图标：图片文件（相对 butler.json，不得越出目录）、http(s) 图片地址，或 emoji/短文字；不写或读不出时显示名称字母。也可在卡片的设置里用文件选择器上传。'],
  ['version', '可选', '整数能力版本；接口或语义变化时递增。'],
  ['frequency', '可选', '"low"：折叠到低频区。'],
  ['hosted', '可选', '需要常驻进程时声明（见下表）。纯动作/纯面板的工具可以没有。'],
  ['health', '可选', '健康检查：{ "url": "…" }，HTTP 2xx 为健康。不写且 hosted 有 port 时，默认探测 http://127.0.0.1:{port}/health/live。'],
  ['panelUrl', '可选', '点卡片打开的二级面板页面（iframe）。'],
  ['panelSize', '可选', '{ "width": 960, "height": 640 }，面板标准尺寸；窗口小时自动缩小。'],
  ['actions', '可选', '卡片底部的动作按钮（见下表）。'],
] as const

/** `hosted` fields. */
export const HOSTED_FIELDS = [
  ['command', '必填', '启动命令：参数数组（推荐）或字符串。'],
  ['cwd', '可选', '工作目录，缺省为 butler.json 所在目录。'],
  ['env', '可选', '额外环境变量（字符串键值）。'],
  ['port', '可选', '监听端口；有 port 且没写 url 时，打开入口为 http://127.0.0.1:{port}。'],
  ['url', '可选', '打开入口。'],
  ['openPath', '可选', '卡片“打开”按钮指向的本地路径。'],
  ['autoStart', '可选', 'true：随 DSH App 启动；缺省 false，需手动启动。'],
  ['restart', '可选', '"never" | "on-failure" | "always"；工具缺省 on-failure（带退避）。'],
] as const

/** `actions[]` fields. */
export const ACTION_FIELDS = [
  ['label', '必填', '按钮文字。'],
  ['url', '必填', '目标地址。'],
  ['mode', '可选', '"panel"（缺省）：在二级面板里打开；"post"：立即向 url 发 POST；"external"：在浏览器新标签打开。'],
  ['title', '可选', '面板标题，缺省同 label。'],
] as const

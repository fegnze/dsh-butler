# Butler Panel

`dsh-butler` 是一个 DSH 插件包，包含 Host 与 Client 两层。Client 只通过同源 `/myspace-butler/*` 路由读取 Host 数据；Host 负责工作目录、扩展物扫描、子进程托管和 DSH App 生命周期。插件不依赖独立 Guardian、独立端口或 LaunchAgent。

## 一个入口：Butler工作台

侧栏只有一行「Butler工作台」，页面顶部的切换器分三个页签：

| 页签 | 作用 | 数据来源 |
| --- | --- | --- |
| 操作台 | 查看工具与服务（添加工具只需指定含 `butler.json` 的目录；添加服务填写托管命令），执行 start/stop/restart 与有限动作；顶部「工作流」实时观测 SDK runner 的运行步骤 | `/overview`、`/operations`、`/runs/stream` |
| 快捷工作台 | 管理并打开路径、文件、应用和 allowlist URL | `/quick-actions` |
| Butler | 卡片知识（待确认 / 卡库 / 会话 / 运行与设置），「运行与设置」内含 doctor、端点与核心 faculty | `/myspace-butler/butler`、`/catalog` |

三个页签共享词典、视觉令牌与同一条标题条，但各自拥有独立 source，且只在选中时挂载、不在后台轮询。操作台另有右侧栏 tab 形态，与页签共用同一组件。

## Client 接缝

`src/client/index.tsx` 是唯一依赖 DSH UI slot 的胶水层，注册 sidebar、main 页面和右侧 tab。`src/ui/` 只依赖 React 与浏览器 API，通过 `getSnapshot` / `subscribe` source 与 Host 通信；组件不接收 `ctx`，不直接访问本地文件。

`external` 动作开新标签，`panel` 动作在受控 iframe 中打开工具页面，`post` 动作由 Host 按 manifest 中的索引执行。浏览器永远不提交任意 command 或 URL 作为执行目标。

## 样式排障

界面宽度、对齐与错位先查 `src/ui/panel-styles.ts`，不要将布局问题当作图片处理任务。操作台与简报使用共享视觉样式，标题与内容应在相同内缩线上。

## 本地开发

```sh
cd /Users/ghost/MySpace/dsh-plugins/dsh-butler
/Users/ghost/MySpace/.venv/bin/python build.py
bun test contract.test.ts
bun run typecheck
```

`contract.test.ts` 检查 DSH slot、route、bundle protocol、布局持久化和上游安装产物接缝。构建输出写入 `dsh/`，发布包通过 `package.json` 的 `files` 字段携带 `skeleton/`、`sdk/`、schema 与静态资源。

## 安装

只安装到 DSH desktop profile；CLI 不支持直接管理该 profile，具体步骤见 [安装说明](README.md#dsh-app-安装)。

开发 profile 可使用 `link:/Users/ghost/MySpace/dsh-plugins/dsh-butler`。不要将此插件加入 Web profile；headless Web 不是 Butler 的生命周期载体。

## 工作目录

本机实例见 [`../../Butler/README.md`](../../Butler/README.md)。通用骨架只放在 [`skeleton/`](skeleton/)；个人路径、凭据和 persona 不得写入 skeleton。插件配置的 `workdir` 指向工作目录后，首次加载会复制骨架，后续只读取并维护该实例。

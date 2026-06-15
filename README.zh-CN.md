# Codex WeChat Bridge

[English README](./README.md)

一个把个人微信 iLink 消息桥接到本地 `codex app-server` 的轻量工具。

当前版本：`0.2.11`

## 它是做什么的

这个项目会运行一个本地守护进程，通过 iLink HTTP 网关接收个人微信消息，并把它们转发到本地 Codex App Server 线程。

它刻意保持精简：

- 单一微信使用者。
- 项目路由同时支持手动固定快捷项目和自动发现的 Codex 工作区。
- 每个项目只维护一个当前活动的 Codex 线程。
- 以文本为主的对话体验，支持图片输入、原生图片回复，以及把生成的工作区产物作为原生文件回传。
- 支持下载微信发来的文件，并把本地路径交给 Codex。
- 不包含 OpenClaw 运行时、插件宿主、Web 管理面板或桌面 UI 自动化。

`Codex.app` 可以与这些持久化线程共存，但桥本身直接对接的是 `codex app-server`。

## 功能特性

- 支持二维码 iLink 登录与 token 持久化。
- 支持长轮询接收微信消息，并持久化游标。
- 线程命令：新建、列出、恢复、中断。
- 项目命令：列出并切换手动固定或自动发现的本地项目。
- 把 Codex 的流式回复按段落、句子或完整列表项回传到微信。
- 在微信里处理审批请求，`1` 同意，`2` 拒绝。
- 当桥第一次拿到可用的微信回复上下文时，会推送一个带版本号的帮助/引导消息；帮助内容更新后，会自动补推一次。
- 微信图片输入：
  - 从 iLink CDN 下载。
  - 解密 AES 媒体载荷。
  - 保存到 `~/.codex-wechat-bridge/assets/`。
  - 作为 `localImage` 输入发送给 Codex。
- 微信文件输入：
  - 从 iLink CDN 下载。
  - 解密 AES 媒体载荷。
  - 保存到 `~/.codex-wechat-bridge/assets/YYYY-MM-DD/files/`。
  - 把保存后的本地路径附加到 turn 文本里，让 Codex 直接读取。
- Codex 图片输出：
  - 优先尝试通过 iLink CDN 上传为原生微信图片消息。
  - 如果上传失败，则退回为文本 URL / 路径，避免结果丢失。
- Codex 文件输出：
  - 在 turn 结束后检测工作区中新生成的产物文件。
  - 把支持的产物作为原生微信文件回传。
  - 如果上传失败，则退回为文本路径。
  - 当前检测策略比较保守：只处理活动工作区中新创建的文档类文件，每个 turn 最多 5 个文件、每个文件最多 20MB。
- 更可靠的流式回传：
  - 对发送做节流，避免 iLink 突发失败。
  - 自动重试瞬时发送失败。
  - 同一微信会话里的文本、图片、文件发送会按顺序串行化，避免流式进度和原生媒体回传互相打架。
  - 把 Codex turn 超时改成“长空闲超时”而不是很短的绝对墙钟上限，默认空闲预算现在是 24 小时。
  - 当长任务长时间没有新的可见进展时，每小时发一条保活提醒，避免微信侧看起来像已经断掉。
  - 尽量避免把很短的段落碎片单独发成微信气泡。
  - 尽量保持编号列表项完整，不在 `1.` / `2.` 这种列表标记处分裂。
  - 在 `ret=-2` 等拒绝场景前后都能对超长内容做切分，避免回复半路被截断。
  - 最终纯文本回复、流式失败后的完整 fallback、以及原生媒体失败后的文本兜底，都会统一走同一条切分重试发送链路。
  - 如果流式分段在切分重试后仍无法完整送达，会额外发送一次完整最终回复，避免前面已经发出去的局部内容掩盖剩余结果。
  - 如果单个 `context_token` 因回复条数预算耗尽而装不下完整回复，bridge 会停在安全边界并提示用户 `回复 1 继续`；下一条纯 `1` 只用于续发剩余尾部文本，不会再把整段完整回复从头重发进微信；续写全部送达后，bridge 会补一条 `Codex 已完成。`。

## 运行要求

- macOS，或任何支持 Node.js 的本地机器。
- Node.js 20+。
- `/Applications/Codex.app` 下安装了 `Codex.app`，或者 `PATH` 中可直接找到 `codex`。
- 通过初始化流程拿到一个有效的个人微信 iLink 账号 token。

## 安装

```bash
npm install
npm run build
```

构建产物会输出到 `dist/`。

如果你是在持久化服务托管的环境里重建，构建后需要执行：

```bash
npm run service -- restart
```

这样正在运行的后台服务才会重新加载新的 `dist` 文件。

这也是本地修复完成后的标准一行重启命令。

## 初始化

先运行一次 setup：

```bash
node dist/cli.js setup --cwd /Users/you/path/to/default-project
```

命令会打印二维码 URL 或二维码载荷。用微信打开或扫码，并确认登录。

当 bridge 拿到可用的微信回复上下文后，会发送当前版本的帮助/引导消息。如果这是全新安装，且之前没有上下文 token，那么只要先给 bridge 发任意一条消息；第一条消息会提供回复上下文，并触发首次帮助推送。

默认情况下，bridge 数据保存在：

```text
~/.codex-wechat-bridge/
```

如果需要，可以使用不同的数据目录：

```bash
node dist/cli.js setup --data-dir /path/to/data --cwd /path/to/project
```

不要拷贝别人的 `~/.codex-wechat-bridge/account.json`。每个使用者都应该用自己的微信账号扫码。

## 运行

前台启动 bridge：

```bash
node dist/cli.js run --cwd /Users/you/path/to/default-project
```

查看本地配置：

```bash
node dist/cli.js status
```

日常使用时，bridge 可以注册成登录后自动启动的用户级后台服务。服务会指向 `dist/cli.js run`，并使用同一个数据目录。

## 持久化后台服务

项目内自带跨平台服务脚本：

```bash
npm run service -- install --cwd /Users/you/path/to/default-project
npm run service -- status
npm run service -- restart
npm run service -- stop
npm run service -- uninstall
```

macOS 会安装用户级 LaunchAgent：

```text
~/Library/LaunchAgents/com.codex.wechat-bridge.plist
```

Windows 会安装登录启动的任务计划程序任务：

```text
CodexWechatBridge
```

如果只是想查看脚本会执行什么，不真正注册服务：

```bash
npm run service -- install --cwd /Users/you/path/to/default-project --dry-run
```

Windows PowerShell 示例：

```powershell
npm run service -- install --cwd C:\Users\you\workspace
npm run service -- status
```

旧的手动 plist 模板仍保留在 `docs/launchagent.example.plist`，主要用于排查或手动部署。

## 项目注册表

列出可用项目：

```bash
node dist/cli.js project list
```

默认情况下，bridge 会合并三类来源：

- `projects.json`：手动固定的项目快捷方式。
- `~/.codex/sessions/**/*.jsonl`：Codex 之前打开过的工作区历史。
- `config.json` 中可选的额外扫描根目录：用于扫描本地 repo / app。

添加一个手动项目快捷方式：

```bash
node dist/cli.js project add misc /Users/you/Documents/misc
```

如果你想把“还没在 Codex 里打开过”的项目也纳入自动发现，可选地在 `~/.codex-wechat-bridge/config.json` 中配置额外扫描根目录：

```json
{
  "projectDiscovery": {
    "codexHistory": true,
    "discoveryRoots": [
      "/Users/you/Documents/Codex_Project"
    ],
    "discoveryMaxDepth": 3
  }
}
```

在微信里，可以按序号或 key 切换：

```text
项目列表
项目 2
项目 misc
线程列表
2
```

在看过 `项目列表` 或 `线程列表` 后，直接回复纯数字会复用该次展示时保存的列表上下文并直接切换。审批态下的 `1` / `2` 仍然优先表示同意 / 拒绝。

如果长回复因为当前微信回复上下文耗尽而被中途截断，bridge 可能会额外提示 `回复 1 继续`。在这个特定状态下，纯文本 `1` 不会进入 Codex，而是直接用下一条消息提供的新 `context_token` 续发剩余尾部回复；续写全部送达后，bridge 会再补一条 `Codex 已完成。`。如果 bridge 正在等待审批，`1` / `2` 仍然优先表示同意 / 拒绝。如果 bridge 重启，或续写状态闲置超过 2 小时，这个续写状态会失效，需要重新提问。

bridge 会为每个项目保存一个活动线程，所以切换项目时会恢复那个项目已保存的活动线程（如果存在）。

## 微信命令

| 命令 | 含义 |
| --- | --- |
| `/help` | 查看帮助说明 |
| `/new`, `新线程` | 新建一个 Codex 线程 |
| `/threads`, `/thread`, `线程`, `线程列表` | 查看可恢复线程；随后可直接回复数字切换 |
| `/resume <index\|thread_id>` | 恢复某个线程 |
| `线程 <index\|thread_id>`, `切线程 <index\|thread_id>` | 中文别名切线程 |
| `/projects`, `/project`, `项目`, `项目列表` | 查看可用项目；随后可直接回复数字切换 |
| `/project <index\|key>`, `项目 <index\|key>` | 切换项目 |
| `/status` | 查看 bridge、项目和线程状态 |
| `/steer <内容>`, `引导 <内容>` | 在 busy 时向当前运行中的 turn 插入额外引导 |
| `/stop`, `停下`, `停止` | 中断当前任务 |
| `/approve`, `1` | 同意待处理的 Codex 请求 |
| `/deny`, `2` | 拒绝待处理的 Codex 请求 |

普通文本会发送到当前项目的活动线程。如果当前没有活动线程，bridge 会自动新建或恢复一个。

特殊情况：如果上一轮明确提示了 `回复 1 继续`，那么纯 `1` 会优先被 bridge 解释成“续发上一轮剩余文本”，而不是新的模型输入；但只要 Codex 正在等待审批，这个 `1` 仍然先走审批快捷键，不会被续写逻辑劫持。

当 Codex 处于 busy 或等待审批状态时，普通文本和项目切换都不会排队，而是直接被拒绝。需要中断时请使用 `/stop`。

如果 Codex 已经处于 busy，且你想往当前运行中的 turn 追加引导，请使用 `/steer <内容>` 或 `引导 <内容>`。这是一个显式入口；普通文本在 busy 时仍会被拦截。

对于长时间运行的 turn，bridge 现在把超时视为“长时间无活动”而不是很短的固定总时长。如果 Codex 很久没有新输出，微信侧会每小时收到一条保活提醒，直到 turn 重新有活动或最终结束。

## 图片与文件

直接给 bridge 发送微信图片。bridge 会把图片保存到本地，并作为 `localImage` 输入转发给 Codex。

直接给 bridge 发送微信文件。bridge 会把文件保存到本地，并把保存后的本地路径附加到 Codex turn 文本中，这样 Codex 就可以在任务期间直接从磁盘打开它。

如果 Codex 产出的图片结果包含本地保存路径或 HTTP(S) URL，bridge 会尝试把它作为原生微信图片消息发送。如果 iLink CDN 上传失败，就退回为文本 URL / 路径，避免结果丢失。

如果某个 turn 在活动工作区里生成了支持的文件，bridge 会检测这些新产物并把它们作为原生微信文件回传。当前检测策略比较保守：只挑选新创建的文档类文件，例如 `pdf`、`docx`、`xlsx`、`pptx`、`zip`、`csv`、`txt`、`md`、`html`，每个 turn 最多 5 个、每个文件最多 20MB。

## 本地数据

默认数据目录：

```text
~/.codex-wechat-bridge/
```

文件包括：

- `account.json`：iLink token 和账号元数据。
- `sync_cursor.json`：长轮询游标。
- `context_tokens.json`：每个用户的回复上下文 token。
- `projects.json`：手动固定的项目快捷方式。
- `bridge-state.json`：当前项目、每个项目的活动线程 id，以及上一次列表展示时保存的列表上下文（用于纯数字切换）。
- `config.json`：bridge 配置，包括可选的项目发现根目录。
- `welcome-state.json`：记录每个 owner 已经收到过哪个版本的帮助/引导。
- `assets/YYYY-MM-DD/*`：保存的微信图片输入。
- `assets/YYYY-MM-DD/files/*`：保存的微信文件输入。
- `logs/bridge.log`：做过脱敏的运行日志。

只要文件系统支持，这些 JSON 状态文件会以“仅当前用户可读写”的权限写入。日志会自动脱敏 bearer token、bot token 和 context token。

## 开发

运行测试：

```bash
npm test
```

TypeScript 类型检查：

```bash
npm run typecheck
```

构建：

```bash
npm run build
```

常见源码入口：

- `src/cli.ts`：setup / run / status / project CLI。
- `src/service.ts`：macOS LaunchAgent / Windows Task Scheduler 服务命令生成。
- `src/wechat/transport.ts`：长轮询 runner 与微信消息处理。
- `src/wechat/ilink-api.ts`：iLink HTTP 客户端与 CDN 媒体上传 / 下载。
- `src/session-router.ts`：命令解析、项目切换、线程路由。
- `src/codex/app-server-client.ts`：基于 JSON 行协议的 Codex App Server 客户端。

## 打包与分发

分发源码时，建议排除这些生成物和本地文件：

- `dist/`
- `node_modules/`
- 日志、缓存和 OS 元数据
- `~/.codex-wechat-bridge/` 运行时数据

解压后执行 `npm install && npm run build`。

## 交给别人使用

发给对方的是源码压缩包，而不是你的运行时数据。接收方应按以下步骤操作：

1. 解压项目。
2. 如有需要，安装 Node.js 20+。
3. 运行 `npm install && npm run build`。
4. 运行 `node dist/cli.js setup --cwd /their/default/workspace`。
5. 用自己的微信账号扫描二维码。
6. 可选：运行 `node dist/cli.js project add <key> <path>` 添加手动快捷项目名。
7. 先前台运行一次 bridge：`node dist/cli.js run --cwd /their/default/workspace`。
8. 在微信里发送 `/status` 和 `/help` 做验证。
9. 可选：运行 `npm run service -- install --cwd /their/default/workspace` 做后台和登录自启。

不要把这些文件一起发给别人：

- `~/.codex-wechat-bridge/account.json`
- `~/.codex-wechat-bridge/context_tokens.json`
- `~/.codex-wechat-bridge/sync_cursor.json`
- `~/.codex-wechat-bridge/logs/*`
- 除非你就是要共享，否则不要带上个人项目路径和下载后的图片资产

接收方需要知道：

- 这个 bridge 使用的是个人微信 iLink。如果 iLink token 初始化失效，对方需要自行打通可用的 iLink 初始化路径；没有企业微信回退方案。
- 它依赖本地 Codex App Server，所以对方机器上的 Codex 登录与模型访问本身必须先能工作。
- bridge 默认把 Codex 线程跑在 `danger-full-access` 下，所以只能在对本地文件访问级别可接受的机器和工作区里运行。
- 它是单 owner 模型。第一个被配置 / 允许的 owner，就是唯一可以使用这个 bridge 的微信发送者。

## 限制

- 仅支持个人微信 iLink；不支持企业微信。
- 单 owner 模式；其他用户发来的消息会被拒绝。
- Codex busy 时没有隐式排队。
- `Codex.app` 中线程可见性是尽力而为的。bridge 会调用 bundled app-server 并通过 deep-link 打开线程，但 GUI 刷新可能滞后。
- 原生图片回复依赖当前个人微信网关与 iLink CDN 上传兼容性。

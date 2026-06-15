# Codex WeChat Bridge

[中文说明](./README.zh-CN.md)

Slim local bridge for personal WeChat iLink messages to `codex app-server`.

Current release: `0.2.11`

## What It Does

This project runs a local daemon that receives personal WeChat messages through the iLink HTTP gateway and forwards them to a local Codex App Server thread.

It is intentionally small:

- One WeChat owner.
- Project routing that combines pinned shortcuts with auto-discovered Codex workspaces.
- One active Codex thread per project.
- Text-first chat with image input, native image replies, and native file replies for generated workspace artifacts.
- Inbound WeChat file download and local-path handoff to Codex.
- No OpenClaw runtime, plugin host, web admin panel, or Desktop UI automation.

`Codex.app` can coexist with the same persisted threads, but the bridge talks to `codex app-server` directly.

## Features

- QR-code iLink login and token persistence.
- Long-poll WeChat receive loop with cursor persistence.
- Thread commands: create, list, resume, stop.
- Project commands: list and switch between pinned or auto-discovered local projects.
- Streaming Codex replies back to WeChat by paragraph, sentence, or intact list item.
- Approval prompts in WeChat with `1` for approve and `2` for deny.
- Versioned onboarding/help message when the bridge first has a usable WeChat reply context, with one-time re-push after guide updates.
- Inbound WeChat images:
  - Download from iLink CDN.
  - Decrypt AES media payloads.
  - Save under `~/.codex-wechat-bridge/assets/`.
  - Send to Codex as `localImage` inputs.
- Inbound WeChat files:
  - Download from iLink CDN.
  - Decrypt AES media payloads.
  - Save under `~/.codex-wechat-bridge/assets/YYYY-MM-DD/files/`.
  - Forward the saved local paths to Codex in the turn text so Codex can read them directly.
- Codex image outputs:
  - Try native WeChat image reply through iLink CDN upload.
  - Fall back to text URL/path if native upload fails.
- Codex file outputs:
  - Detect newly generated workspace artifacts after a turn finishes.
  - Send supported artifacts back as native WeChat files.
  - Fall back to text path if native upload fails.
  - Current detection is intentionally conservative: only newly created document-like files inside the active workspace are eligible, up to 5 files per turn and 20MB per file.
- More reliable streaming:
  - Throttle chunk sends to avoid iLink burst failures.
  - Retry transient send failures.
  - Serialize text, image, and file sends per WeChat user so streamed progress and native media replies do not overlap and trip iLink `ret=-2`.
  - Treat Codex turn timeout as a long idle timeout instead of a short absolute wall-clock limit; the default idle budget is now 24 hours.
  - Send an hourly keepalive notice when a long-running turn has no new visible progress, so WeChat does not look dead during quiet stretches.
  - Avoid tiny paragraph fragments becoming standalone WeChat bubbles mid-reply.
  - Keep numbered list items together instead of splitting on `1.` / `2.` markers.
  - Split oversized chunks before or after `ret=-2` rejections so replies do not get cut off halfway.
  - Route final plain-text replies, streamed-reply fallbacks, and native media text fallbacks through the same split-and-retry path.
  - If a streamed chunk still cannot be delivered completely after split retries, send the complete final reply as a fallback so partial bubbles do not hide the rest of the answer.
  - If one `context_token` runs out of reply-budget before the whole reply fits, pause at a safe boundary, ask the user to reply `1`, and continue only the remaining tail on the next reply token without sending that `1` into Codex; once that continuation finishes, send `Codex 已完成。`.

## Requirements

- macOS or another Node-capable local machine.
- Node.js 20+.
- `Codex.app` installed at `/Applications/Codex.app`, or `codex` available on `PATH`.
- A valid personal WeChat iLink account token created by the setup flow.

## Install

```bash
npm install
npm run build
```

The build output goes to `dist/`.

If you rebuild a service-managed install, run `npm run service -- restart` afterward so the running service reloads the new `dist` files.

The same service restart command is the normal one-line restart after a local fix has been built.

## Setup

Run setup once:

```bash
node dist/cli.js setup --cwd /Users/you/path/to/default-project
```

The command prints a QR URL or QR payload. Open or scan it with WeChat and confirm the login.

After the bridge has a usable WeChat reply context, it sends a one-time onboarding message explaining the main commands. If this is a fresh setup and no previous context token exists, send any message to the bridge once; that first message provides the reply context and triggers onboarding.

By default, bridge data is stored in:

```text
~/.codex-wechat-bridge/
```

Use a different data directory when needed:

```bash
node dist/cli.js setup --data-dir /path/to/data --cwd /path/to/project
```

Do not copy another user's `~/.codex-wechat-bridge/account.json`. Each recipient should scan with their own WeChat account.

## Run

Start the bridge in the foreground:

```bash
node dist/cli.js run --cwd /Users/you/path/to/default-project
```

Check local config:

```bash
node dist/cli.js status
```

For daily use, the bridge can run as a login-started user service. The service points at `dist/cli.js run` and uses the same data directory.

## Persistent Service

The project includes a cross-platform service helper:

```bash
npm run service -- install --cwd /Users/you/path/to/default-project
npm run service -- status
npm run service -- restart
npm run service -- stop
npm run service -- uninstall
```

On macOS, it installs a user LaunchAgent:

```text
~/Library/LaunchAgents/com.codex.wechat-bridge.plist
```

On Windows, it installs a login-started Task Scheduler task:

```text
CodexWechatBridge
```

To preview the commands without registering anything:

```bash
npm run service -- install --cwd /Users/you/path/to/default-project --dry-run
```

Windows PowerShell example:

```powershell
npm run service -- install --cwd C:\Users\you\workspace
npm run service -- status
```

The old manual plist template remains in `docs/launchagent.example.plist` for troubleshooting and hand-managed deployments.

## Project Registry

List available projects:

```bash
node dist/cli.js project list
```

By default the bridge merges three sources:

- `projects.json`: manual project shortcuts.
- `~/.codex/sessions/**/*.jsonl`: workspaces that Codex has already opened before.
- Optional extra roots from `config.json`: directories to scan for local repos/apps.

Add a manual project shortcut:

```bash
node dist/cli.js project add misc /Users/you/Documents/misc
```

Optional: add extra discovery roots in `~/.codex-wechat-bridge/config.json` if you want to include projects that have not been opened in Codex yet:

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

In WeChat, switch by index or key:

```text
项目列表
项目 2
项目 misc
线程列表
2
```

After `项目列表` or `线程列表`, replying with a bare number reuses the list context saved for that display and switches directly. Approval-mode `1` / `2` still keep their existing approve / deny behavior.

When a long reply is truncated because the current WeChat reply context is exhausted, the bridge may instead send `回复 1 继续`. In that specific state, a plain `1` does not go to Codex; it only resumes the remaining tail of the reply on the next `context_token`, and once that continuation finishes the bridge sends `Codex 已完成。`. If the bridge is awaiting approval, approve / deny still take priority. If the bridge restarts or the continuation sits idle for more than 2 hours, that continuation state expires and must be restarted with a fresh user request.

The bridge stores one active thread per project, so switching projects restores that project's saved active thread when available.

## WeChat Commands

| Command | Meaning |
| --- | --- |
| `/help` | Show command help |
| `/new`, `新线程` | Start a new Codex thread |
| `/threads`, `/thread`, `线程`, `线程列表` | List available threads; a follow-up bare number resumes that thread |
| `/resume <index\|thread_id>` | Resume a thread |
| `线程 <index\|thread_id>`, `切线程 <index\|thread_id>` | Resume a thread with Chinese alias |
| `/projects`, `/project`, `项目`, `项目列表` | List available projects; a follow-up bare number switches project |
| `/project <index\|key>`, `项目 <index\|key>` | Switch project |
| `/status` | Show bridge, project, and thread status |
| `/steer <text>`, `引导 <内容>` | Insert guidance into the active busy turn |
| `/stop`, `停下`, `停止` | Interrupt the active turn |
| `/approve`, `1` | Approve a pending Codex request |
| `/deny`, `2` | Deny a pending Codex request |

Plain text is sent to the active thread in the current project. If no active thread exists, the bridge starts or resumes one automatically.

Special case: if the previous reply explicitly said `回复 1 继续`, then a bare `1` resumes that pending WeChat-only continuation instead of entering Codex as user text. This continuation-only `1` is ignored when Codex is awaiting approval, so approval shortcuts keep working.

When Codex is busy or waiting for approval, ordinary text and project switching are rejected instead of queued. Use `/stop` to interrupt.

If Codex is already busy and you want to inject extra guidance into the current running turn, use `/steer <text>` or `引导 <内容>`. This is explicit-only: ordinary text is still rejected while busy.

For long-running turns, the bridge now treats timeout as inactivity-based rather than a short fixed wall-clock deadline. If Codex stays quiet for a long time, WeChat receives one keepalive notice per hour until new activity arrives or the turn finishes.

## Images And Files

Send a WeChat image directly to the bridge. The bridge saves it locally and forwards it to Codex as a `localImage` input.

Send a WeChat file directly to the bridge. The bridge saves it locally and appends the saved local path to the Codex turn text, so Codex can open the file from disk during the task.

If Codex produces an image output with either a saved local path or an HTTP(S) URL, the bridge tries to send a native WeChat image message. If iLink CDN upload fails, it replies with the URL/path as text so the output is not lost.

If a turn creates supported new files inside the active workspace, the bridge detects those new artifacts and sends them back as native WeChat files. Current detection is intentionally conservative: it only picks newly created files with document-like extensions such as `pdf`, `docx`, `xlsx`, `pptx`, `zip`, `csv`, `txt`, `md`, and `html`, up to 5 files per turn and 20MB per file.

## Local Data

Default data directory:

```text
~/.codex-wechat-bridge/
```

Files:

- `account.json`: iLink token and account metadata.
- `sync_cursor.json`: long-poll cursor.
- `context_tokens.json`: per-user reply context token.
- `projects.json`: manual project shortcuts.
- `bridge-state.json`: active project, per-project active thread ids, and the most recent list context for bare-number switching.
- `config.json`: bridge config, including optional project discovery roots.
- `welcome-state.json`: tracks which onboarding/help guide version each owner has already received.
- `assets/YYYY-MM-DD/*`: inbound WeChat images saved for Codex.
- `assets/YYYY-MM-DD/files/*`: inbound WeChat files saved for Codex.
- `logs/bridge.log`: redacted runtime logs.

JSON state files are written with current-user-only permissions where the filesystem supports it. Logs redact bearer tokens, bot tokens, and context tokens.

## Development

Run tests:

```bash
npm test
```

Type-check:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

Useful source entry points:

- `src/cli.ts`: setup/run/status/project CLI.
- `src/service.ts`: macOS LaunchAgent / Windows Task Scheduler service command generation.
- `src/wechat/transport.ts`: long-poll runner and WeChat message handling.
- `src/wechat/ilink-api.ts`: iLink HTTP client and CDN media upload/download.
- `src/session-router.ts`: command parsing, project switching, thread routing.
- `src/codex/app-server-client.ts`: JSON-line Codex App Server client.

## Packaging

For source distribution, exclude generated and local-only files:

- `dist/`
- `node_modules/`
- logs, caches, and OS metadata
- `~/.codex-wechat-bridge/` runtime data

Build after unpacking with `npm install && npm run build`.

## Handing This To Someone Else

Send them the source zip, not your runtime data. The recipient should:

1. Unzip the project.
2. Install Node.js 20+ if needed.
3. Run `npm install && npm run build`.
4. Run `node dist/cli.js setup --cwd /their/default/workspace`.
5. Scan the QR code with their own WeChat account.
6. Optional: add manual shortcuts with `node dist/cli.js project add <key> <path>` for names you want to pin or override.
7. Run the bridge in foreground once with `node dist/cli.js run --cwd /their/default/workspace`.
8. Send `/status` and `/help` from WeChat to verify the bridge.
9. Optional: run `npm run service -- install --cwd /their/default/workspace` for background login autostart.

Do not include these files when handing it off:

- `~/.codex-wechat-bridge/account.json`
- `~/.codex-wechat-bridge/context_tokens.json`
- `~/.codex-wechat-bridge/sync_cursor.json`
- `~/.codex-wechat-bridge/logs/*`
- Any personal project paths or downloaded image assets unless intentionally shared.

What they need to know:

- This bridge uses personal WeChat iLink. If iLink token setup stops working, they need a valid iLink setup path; there is no enterprise WeChat fallback.
- It uses local Codex App Server, so their Codex login and model access must already work locally.
- The bridge defaults Codex threads to `danger-full-access`. They should only run it on machines and workspaces where they accept that level of local file access.
- It is single-owner. The first configured/allowed owner is the only WeChat sender that can use it.

## Limits

- Personal WeChat iLink only; enterprise WeChat is not supported.
- Single owner model; messages from other users are rejected.
- No implicit queue for messages while Codex is busy.
- `Codex.app` thread visibility is best-effort. The bridge uses the bundled app-server and deep-links opened threads, but GUI refresh can lag.
- Native image replies depend on iLink CDN upload compatibility with the current personal WeChat gateway.

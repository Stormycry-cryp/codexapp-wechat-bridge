# Changelog

## Unreleased

## 0.2.9 - 2026-04-29

- Added automatic project discovery:
  - Merges manual `projects.json` shortcuts with Codex history from `~/.codex/sessions/**/*.jsonl`.
  - Supports optional `projectDiscovery.discoveryRoots` scanning from `config.json`.
  - Normalizes historical `cwd` values upward to project roots so non-project paths are filtered out.
- Added WeChat bare-number list shortcuts:
  - After `线程列表`, replying with a bare number resumes the matching thread from the most recently shown list.
  - After `项目列表`, replying with a bare number switches to the matching project from the most recently shown list.
  - Approval-mode `1` / `2` still keep higher priority for approve / deny.
- Added inbound WeChat file support:
  - Parses `file_item` media references from iLink updates.
  - Downloads and decrypts file bytes from WeChat CDN.
  - Saves files under `~/.codex-wechat-bridge/assets/YYYY-MM-DD/files/`.
  - Forwards saved local file paths to Codex in the turn text so Codex can read the files directly.
- Added outbound WeChat file replies for generated workspace artifacts:
  - Detects newly created document-like files after a Codex turn completes.
  - Uploads those files through iLink CDN with `media_type=3`.
  - Sends native WeChat `file_item` replies, with text fallback if upload fails.
- Fixed streamed reply truncation more defensively:
  - Retries transient send failures instead of silently dropping chunks.
  - Adds a minimum send interval to reduce iLink burst failures.
  - Splits oversized chunks proactively and also after `ret=-2` rejections.
- Maintenance:
  - Updated the setup banner and README to mention file support, project auto-discovery, and bare-number list shortcuts.
  - Clarified README limits for generated file detection and documented that LaunchAgent installs need a `kickstart` after rebuilding `dist/`.
  - Fixed the local dev dependency range for `@types/node` so `npm install` works with currently available registry versions.

## 0.2.8 - 2026-04-28

- Added a one-time WeChat onboarding message:
  - Sent on startup when an owner context token already exists.
  - Otherwise sent before handling the first owner message that provides a reply context token.
  - Stored in `welcome-state.json` so it does not repeat on every restart.

## 0.2.7 - 2026-04-28

- Added native WeChat image replies for Codex image outputs:
  - Encrypts image bytes with AES-128-ECB.
  - Requests iLink CDN upload URLs with `ilink/bot/getuploadurl`.
  - Uploads encrypted bytes to WeChat CDN.
  - Sends an iLink `image_item` message through `ilink/bot/sendmessage`.
- Keeps text URL/path fallback if native image sending fails.
- Maintenance:
  - Centralized bridge version/channel version constants.
  - Rewrote README with setup, run, command, image, storage, development, and packaging notes.
  - Added handoff instructions for giving the project to another user.
  - Added a macOS LaunchAgent example plist.
  - Removed local package cache from the working tree.

## 0.2.6 - 2026-04-28

- Added inbound WeChat image support for personal iLink messages:
  - Parses `image_item` media references from iLink updates.
  - Downloads and decrypts image bytes from WeChat CDN.
  - Saves images under `~/.codex-wechat-bridge/assets/YYYY-MM-DD/` with user-only permissions.
  - Sends saved images to Codex app-server as `localImage` turn inputs.
- Added image-generation output rendering as WeChat text with image URL and/or saved local path when app-server reports image output metadata.

## 0.2.5 - 2026-04-28

- Added Chinese aliases for common WeChat commands:
  - `停下` / `停止` for `/stop`.
  - `项目` / `项目列表` / `项目 <index|key>` for project listing and switching.
  - `线程` / `线程列表` / `线程 <index|thread_id>` / `切线程 <index|thread_id>` for thread listing and switching.
  - `新线程` for `/new`.

## 0.2.4 - 2026-04-28

- Added `/thread` and `/thread列表` aliases for listing recent Codex threads.
- Prevented those aliases from falling through as ordinary Codex messages.

## 0.2.3 - 2026-04-28

- Added WeChat approval shortcuts: reply `1` to approve and `2` to deny while Codex is awaiting approval.
- Expanded approval prompts with command, working directory, reason, and requested permissions so the user can see what is being approved.
- Changed bridge-created and resumed Codex threads to default to `danger-full-access`.

## 0.2.2 - 2026-04-28

- Fixed app-server approval requests being swallowed by the JSON-line RPC client.
- Added WeChat `/approve` and `/deny` commands for pending Codex command, file-change, and permission requests.
- Forward approval prompts to WeChat so remote tasks do not appear to hang after the initial receipt message.

## 0.2.1 - 2026-04-28

- Changed streamed Codex replies to send as natural WeChat messages by paragraph or sentence instead of fixed-size chunks.
- Kept fenced code blocks together while streaming, so commands and snippets do not arrive half-cut.
- Made `/project` without arguments list projects, matching `/projects`.

## 0.2.0 - 2026-04-28

- Added WeChat project commands: `/projects` and `/project <index|key>`.
- Added CLI project registry commands: `project list` and `project add`.
- Switched bridge state to per-project active thread persistence with legacy `activeThreadId` migration.
- Improved Desktop coexistence by preferring the bundled Codex app-server and deep-linking active threads back into `Codex.app`.
- Improved long-task UX with immediate receipt confirmation and throttled streamed reply chunks.

## 0.1.0 - 2026-04-28

- Initial local bridge implementation for personal WeChat iLink to `codex app-server`.
- Added QR setup, long-poll receiving, text routing, thread lifecycle commands, local JSON storage, and LaunchAgent-oriented runtime support.

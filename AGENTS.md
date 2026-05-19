# AGENTS.md

## User Rules
- 决不允许使用 MCP 直接修改 GitLab 的代码，除非用户明确要求；即使用户明确要求，也需要再次确认。
- 如果要动原有项目的共享组件，先带着改动内容和方向向用户额外确认。
- 实事求是；缺少前置信息时直接说明，不编造，不用类似信息替代。
- 忠实于事实和用户利益，不一味附和。
- 当没有给用户选项而用户回复 `1` 时，代表同意。
- 本项目提交信息默认使用中文，包括提交标题和提交描述；除非用户明确要求英文。
- 本项目的 PR / MR 标题与描述默认也使用中文；除非用户明确要求英文。
- 项目级编程任务默认使用 `planning-with-files`，每个线程独立；开始时先检查是否已有记录。计划文件不要放在项目内，放到项目外独立目录。
- 绝对不要反复 `git pull`；除非用户主动要求对齐 GitLab，否则不要主动拉代码。

## Project Snapshot
- This is a local TypeScript/Node bridge from personal WeChat iLink messages to `codex app-server`.
- Runtime entrypoint is `src/cli.ts`; build output goes to `dist/`.
- Main WeChat loop is `src/wechat/transport.ts`.
- Streaming chunk buffering/retry/split logic is `src/wechat/progress-sender.ts`.
- Codex app-server RPC integration is `src/codex/app-server-client.ts`.
- The macOS LaunchAgent example is `docs/launchagent.example.plist`.

## Verification
- Run `npm test` for the Vitest suite.
- Run `npm run typecheck` for TypeScript checking without emitting.
- Run `npm run build` before restarting a LaunchAgent-managed bridge.
- After changing this bridge and successfully rebuilding `dist`, automatically restart the local LaunchAgent with `launchctl kickstart -k "gui/$(id -u)/com.codex.wechat-bridge"` unless the user explicitly asks not to.

## Streaming Notes
- Progress streaming sends natural paragraph/sentence chunks and keeps fenced code blocks together.
- Tiny paragraph fragments should stay buffered until there is enough surrounding text to form a meaningful WeChat bubble.
- Numbered or bulleted list items should stream as intact chunks; do not treat `1.` / `2.` style list markers as ordinary sentence endings.
- Long-running turns now use a 24-hour idle timeout; activity from Codex events should refresh that timer instead of letting a short absolute wall-clock deadline kill the turn.
- When a turn goes quiet for a long time, the bridge sends at most one keepalive notice per hour until visible activity resumes or the turn ends.
- Send failures are retried and oversized chunks are split before/after iLink rejection handling.
- Outbound WeChat sends for the same user must stay serialized across text, image, and file paths; overlapping sends can trigger iLink `ret=-2` and make later reply content disappear.
- Final plain-text replies and media text fallbacks should go through the same reliable split/retry path as streamed chunks.
- If any progress chunk is ultimately undeliverable, `WechatBridgeRunner` now sends a complete final-reply fallback: `流式回传不完整，下面是完整回复：...`.
- Do not remove that fallback just because some partial chunks already reached WeChat; that is the exact truncation case it prevents.
- When a single `context_token` still cannot carry the complete reply, the bridge now pauses at a safe boundary and asks the user to reply `1` to continue.
- When that continuation path is triggered by local WeChat reply-budget exhaustion, it should continue only the unsent tail instead of replaying the whole final reply from the beginning.
- After that continuation finishes, the bridge should send a final `Codex 已完成。` notice so WeChat still gets an explicit completion signal.
- That continuation-only `1` is intercepted in `src/wechat/transport.ts` and must not be forwarded into Codex as ordinary user text.
- Approval-mode `1` / `2` still take priority over continuation handling, and continuation state currently lives in memory only with a 2-hour TTL.

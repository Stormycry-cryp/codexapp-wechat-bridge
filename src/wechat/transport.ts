import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CodexFileOutput, CodexImageOutput, CodexInputFile, CodexInputImage } from "../codex/app-server-client.js";
import type { BridgeConfig, WechatAccount } from "../config.js";
import { saveConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { BridgeStore } from "../storage.js";
import type { SessionRouter } from "../session-router.js";
import { IlinkApiClient } from "./ilink-api.js";
import { detectImageMime, imageExtensionForMime } from "./media.js";
import { toInboundWechatMessage } from "./message.js";
import { ProgressSender } from "./progress-sender.js";
import type { InboundWechatMessage, WechatCdnRef, WechatFileRef } from "./types.js";

type ContextTokenMap = Record<string, string>;
type WelcomeState = {
  sentTo?: Record<string, boolean>;
};

export type WechatBridgeRunnerOptions = {
  config: BridgeConfig;
  account: WechatAccount;
  store: BridgeStore;
  router: SessionRouter;
  logger: Logger;
};

type InboundAttachmentSaveOptions<TRef extends WechatCdnRef, TOutput> = {
  kind: "image" | "file";
  subdir?: string;
  fileName: (messagePrefix: string, ref: TRef, index: number, bytes: Buffer) => string;
  toOutput: (target: string, ref: TRef) => TOutput;
};

export class WechatBridgeRunner {
  private stopping = false;
  private readonly api: IlinkApiClient;
  private readonly seen = new Map<string, number>();

  constructor(private readonly options: WechatBridgeRunnerOptions) {
    this.api = new IlinkApiClient({
      baseUrl: options.account.baseUrl || options.config.ilinkBaseUrl,
      token: options.account.token,
      routeTag: options.config.routeTag
    });
  }

  stop(): void {
    this.stopping = true;
  }

  async runForever(): Promise<void> {
    await this.options.logger.info("bridge runner started", {
      workspace: this.options.config.workspace,
      ownerUserId: this.ownerUserId() || "(first message will claim owner)"
    });
    await this.sendStartupWelcomeIfPossible();
    let errorDelayMs = 1000;
    while (!this.stopping) {
      try {
        await this.pollOnce();
        errorDelayMs = 1000;
      } catch (error) {
        await this.options.logger.warn("poll failed", describeError(error));
        if (error instanceof WechatTokenExpiredError) {
          await this.options.logger.warn("WeChat token expired; run setup again before restarting the bridge.");
          this.stop();
          return;
        }
        await delay(errorDelayMs);
        errorDelayMs = Math.min(errorDelayMs * 2, 30_000);
      }
    }
  }

  async pollOnce(): Promise<void> {
    const cursor = await this.options.store.readJson<{ cursor: string }>("sync_cursor.json", { cursor: "" });
    const response = await this.api.getUpdates(cursor.cursor, this.options.config.longPollTimeoutMs);
    if (response.errcode === -14) {
      throw new WechatTokenExpiredError("WeChat iLink token expired; run setup again.");
    }
    if (response.get_updates_buf) {
      await this.options.store.writeJson("sync_cursor.json", { cursor: response.get_updates_buf });
    }

    for (const raw of response.msgs ?? []) {
      const message = toInboundWechatMessage(raw);
      if (!message || this.isDuplicate(message)) continue;
      void this.handleMessage(message).catch(async (error) => {
        await this.options.logger.error("message handling failed", error);
      });
    }
  }

  private async handleMessage(message: InboundWechatMessage): Promise<void> {
    if (!(await this.isAllowedOwner(message.userId))) {
      await this.options.logger.warn("rejected message from non-owner", { userId: message.userId });
      return;
    }

    if (message.contextToken) {
      const tokens = await this.options.store.readJson<ContextTokenMap>("context_tokens.json", {});
      tokens[message.userId] = message.contextToken;
      await this.options.store.writeJson("context_tokens.json", tokens);
    }

    const token = message.contextToken || (await this.options.store.readJson<ContextTokenMap>("context_tokens.json", {}))[message.userId];
    if (!token) {
      await this.options.logger.warn("missing context token; cannot reply", { userId: message.userId });
      return;
    }
    await this.maybeSendWelcome(message.userId, token);

    await this.options.logger.info("received wechat text", {
      userId: message.userId,
      messageId: message.id,
      command: commandName(message.content),
      length: message.content.length,
      imageCount: message.images?.length ?? 0,
      fileCount: message.files?.length ?? 0
    });

    const progress = this.createProgressSender(message.userId, token);
    const images = await this.saveInboundImages(message);
    const files = await this.saveInboundFiles(message);
    const inboundAttachmentCount = (message.images?.length ?? 0) + (message.files?.length ?? 0);
    if (inboundAttachmentCount > 0 && images.length === 0 && files.length === 0 && !message.content.trim()) {
      await progress.sendNotice("收到附件，但下载或解密失败；请重新发送，或补一段文字说明。");
      return;
    }
    const isCommand = images.length === 0 && files.length === 0 && message.content.trim().startsWith("/");
    if (!isCommand) {
      await progress.sendNotice("收到，Codex 开始处理。长任务会分段回传，/stop 可中断。");
    }

    let reply: string;
    let deliveredNativeOutput = false;
    try {
      reply = await this.options.router.handleInput({
        text: message.content,
        images,
        files
      }, {
        onDelta: (delta) => progress.push(delta),
        onApproval: (request) => progress.sendNotice(request.summary),
        onImageOutput: async (output) => {
          await this.sendImageOutput(message.userId, token, output);
          deliveredNativeOutput = true;
        },
        onFileOutput: async (output) => {
          await this.sendFileOutput(message.userId, token, output);
          deliveredNativeOutput = true;
        }
      });
    } catch (error) {
      reply = `Bridge error: ${describeError(error)}`;
      await this.options.logger.error("router failed", error);
    }

    await progress.flushAll();
    let sentIncompleteFallback = false;
    if (progress.hasDeliveryFailure() && reply) {
      await progress.sendNotice(`流式回传不完整，下面是完整回复：\n\n${reply}`);
      sentIncompleteFallback = true;
    }
    if (progress.hasStreamedOutput()) {
      await progress.sendNotice("Codex 已完成。");
    } else if (reply && !sentIncompleteFallback && !(deliveredNativeOutput && reply === "(Codex completed without text output.)")) {
      await this.sendText(message.userId, token, reply);
    }
  }

  private createProgressSender(userId: string, contextToken: string): ProgressSender {
    return new ProgressSender({
      send: (text) => this.sendText(userId, contextToken, text),
      logger: this.options.logger
    });
  }

  private async sendText(userId: string, contextToken: string, text: string): Promise<void> {
    await this.api.sendText(userId, text, contextToken, `cwb-${randomBytes(6).toString("hex")}`);
  }

  private async sendStartupWelcomeIfPossible(): Promise<void> {
    const owner = this.ownerUserId();
    if (!owner) return;
    const tokens = await this.options.store.readJson<ContextTokenMap>("context_tokens.json", {});
    const token = tokens[owner];
    if (!token) return;
    await this.maybeSendWelcome(owner, token);
  }

  private async maybeSendWelcome(userId: string, contextToken: string): Promise<void> {
    const state = await this.options.store.readJson<WelcomeState>("welcome-state.json", {});
    if (state.sentTo?.[userId]) return;
    await this.sendText(userId, contextToken, welcomeMessage());
    await this.options.store.writeJson("welcome-state.json", {
      sentTo: {
        ...(state.sentTo ?? {}),
        [userId]: true
      }
    });
  }

  private async sendImageOutput(userId: string, contextToken: string, output: CodexImageOutput): Promise<void> {
    try {
      const bytes = await this.loadOutputImageBytes(output);
      await this.api.sendImage(userId, bytes, contextToken, `cwb-img-${randomBytes(6).toString("hex")}`);
    } catch (error) {
      await this.options.logger.warn("failed to send native wechat image output", {
        error: describeError(error),
        hasPath: Boolean(output.path),
        hasUrl: Boolean(output.url)
      });
      await this.sendText(userId, contextToken, output.fallbackText);
    }
  }

  private async sendFileOutput(userId: string, contextToken: string, output: CodexFileOutput): Promise<void> {
    try {
      const bytes = await readFile(output.path);
      await this.api.sendFile(userId, fileNameFromPath(output.path), bytes, contextToken, `cwb-file-${randomBytes(6).toString("hex")}`);
    } catch (error) {
      await this.options.logger.warn("failed to send native wechat file output", {
        error: describeError(error),
        path: output.path
      });
      await this.sendText(userId, contextToken, output.fallbackText);
    }
  }

  private async loadOutputImageBytes(output: CodexImageOutput): Promise<Buffer> {
    if (output.path) {
      return await readFile(output.path);
    }
    if (output.url) {
      return await fetchLimitedBytes(output.url, 25 * 1024 * 1024);
    }
    throw new Error("image output has neither path nor url");
  }

  private async saveInboundImages(message: InboundWechatMessage): Promise<CodexInputImage[]> {
    return await this.saveInboundAttachments(message, message.images ?? [], {
      kind: "image",
      fileName: (messagePrefix, _ref, index, bytes) => {
        const mime = detectImageMime(bytes);
        return `${messagePrefix}-${index + 1}${imageExtensionForMime(mime)}`;
      },
      toOutput: (target) => ({ path: target })
    });
  }

  private async saveInboundFiles(message: InboundWechatMessage): Promise<CodexInputFile[]> {
    return await this.saveInboundAttachments(message, message.files ?? [], {
      kind: "file",
      subdir: "files",
      fileName: (messagePrefix, ref, index) => `${messagePrefix}-${index + 1}-${safeAttachmentName(ref.fileName, ".bin")}`,
      toOutput: (target, ref: WechatFileRef) => ({
        path: target,
        originalName: ref.fileName
      })
    });
  }

  private async saveInboundAttachments<TRef extends WechatCdnRef, TOutput>(
    message: InboundWechatMessage,
    refs: TRef[],
    options: InboundAttachmentSaveOptions<TRef, TOutput>
  ): Promise<TOutput[]> {
    if (refs.length === 0) return [];
    const dir = inboundAttachmentDir(this.options.store.path("assets"), options.subdir);
    const messagePrefix = safeFilePart(message.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const saved: TOutput[] = [];
    for (const [index, ref] of refs.entries()) {
      try {
        const bytes = await this.api.downloadCdnMedia(ref);
        const target = join(dir, options.fileName(messagePrefix, ref, index, bytes));
        await writeFile(target, bytes, { mode: 0o600 });
        saved.push(options.toOutput(target, ref));
      } catch (error) {
        await this.options.logger.warn(`failed to save inbound wechat ${options.kind}`, {
          messageId: message.id,
          index,
          error: describeError(error)
        });
      }
    }
    return saved;
  }

  private ownerUserId(): string {
    return this.options.config.ownerUserId || this.options.account.ilinkUserId || "";
  }

  private async isAllowedOwner(userId: string): Promise<boolean> {
    const owner = this.ownerUserId();
    if (owner) return owner.toLowerCase() === userId.toLowerCase();
    this.options.config.ownerUserId = userId;
    await saveConfig(this.options.store, this.options.config);
    await this.options.logger.warn("owner user was empty; claimed first sender", { userId });
    return true;
  }

  private isDuplicate(message: InboundWechatMessage): boolean {
    const now = Date.now();
    for (const [key, timestamp] of this.seen) {
      if (now - timestamp > 5 * 60_000) this.seen.delete(key);
    }
    const key = `${message.userId}:${message.id}`;
    if (this.seen.has(key)) return true;
    this.seen.set(key, now);
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class WechatTokenExpiredError extends Error {}

function commandName(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) return "(text)";
  return trimmed.split(/\s+/, 1)[0] || "/";
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || randomBytes(4).toString("hex");
}

function inboundAttachmentDir(root: string, subdir?: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return subdir ? join(root, date, subdir) : join(root, date);
}

function safeAttachmentName(fileName: string | undefined, fallbackExt: string): string {
  const raw = fileName?.trim().split(/[\\/]/).pop() ?? "";
  const extension = extname(raw).slice(0, 20).replace(/[^a-zA-Z0-9.]+/g, "") || fallbackExt;
  const base = raw.slice(0, raw.length - extname(raw).length).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+/, "").slice(0, 80);
  if (base) return `${base}${extension}`;
  return `attachment${extension}`;
}

function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "artifact.bin";
}

export function welcomeMessage(): string {
  return [
    "Codex 微信桥已连接。",
    "",
    "常用：",
    "- 直接发文字：发送到当前 Codex 线程",
    "- 发图片：作为图片输入给 Codex",
    "- 发文件：保存为本地文件并把路径交给 Codex",
    "- /new 或 新线程：新建线程",
    "- /thread 或 线程列表：查看线程序号，随后可直接回复数字切换",
    "- /resume <序号> 或 线程 <序号>：切换线程",
    "- 项目列表 / 项目 <序号|key>：查看或切换项目，随后可直接回复数字切换",
    "- /status：查看状态",
    "- /stop / 停下：中断当前任务",
    "- Codex 要权限时，回复 1 同意，2 拒绝",
    "",
    "发送 /help 可随时再看命令。"
  ].join("\n");
}

async function fetchLimitedBytes(url: string, maxBytes: number): Promise<Buffer> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`unsupported image URL: ${url}`);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`image URL HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new Error(`image URL exceeds ${maxBytes} bytes`);
  }
  return bytes;
}

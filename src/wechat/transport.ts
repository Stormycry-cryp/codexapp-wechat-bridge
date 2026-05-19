import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CODEX_NO_TEXT_OUTPUT_MESSAGE, type CodexFileOutput, type CodexImageOutput, type CodexInputFile, type CodexInputImage } from "../codex/app-server-client.js";
import type { BridgeConfig, WechatAccount } from "../config.js";
import { saveConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { helpMessage } from "../session-router.js";
import type { BridgeStore } from "../storage.js";
import type { SessionRouter } from "../session-router.js";
import { IlinkApiClient } from "./ilink-api.js";
import { detectImageMime, imageExtensionForMime } from "./media.js";
import { toInboundWechatMessage } from "./message.js";
import { chunkTextForWechat, ProgressSender } from "./progress-sender.js";
import type { InboundWechatMessage, WechatCdnRef, WechatFileRef } from "./types.js";

type ContextTokenMap = Record<string, string>;
type WelcomeState = {
  version?: number;
  sentTo?: Record<string, number | boolean>;
};

const WELCOME_MESSAGE_VERSION = 2;
const LONG_TASK_KEEPALIVE_INTERVAL_MS = 60 * 60_000;
const LONG_TASK_KEEPALIVE_MESSAGE = "任务仍在处理中，暂无新进展；/stop 可中断。";
const WECHAT_CONTEXT_MAX_SENDS = 10;
const WECHAT_CONTEXT_RESERVED_TAIL_SENDS = 6;
const WECHAT_CONTEXT_BUDGET_EXCEEDED = "wechat context send budget reached";
const CONTINUATION_PROMPT_MESSAGE = "回复 1 继续";
const CONTINUATION_EXPIRED_MESSAGE = "上一轮续写状态已失效，请重新提问。";
const CONTINUATION_STATE_TTL_MS = 2 * 60 * 60_000;

export type WechatBridgeRunnerOptions = {
  config: BridgeConfig;
  account: WechatAccount;
  store: BridgeStore;
  router: SessionRouter;
  logger: Logger;
  progressSendIntervalMs?: number;
  reliableSendIntervalMs?: number;
};

type InboundAttachmentSaveOptions<TRef extends WechatCdnRef, TOutput> = {
  kind: "image" | "file";
  subdir?: string;
  fileName: (messagePrefix: string, ref: TRef, index: number, bytes: Buffer) => string;
  toOutput: (target: string, ref: TRef) => TOutput;
};

type DeliveryContext = {
  userId: string;
  contextToken: string;
  messageId: string;
  startedAt: number;
  degraded: boolean;
  sentMessageCount: number;
  budgetStopLogged: boolean;
};

type DeliveryPhase = "notice" | "stream" | "fallback" | "completion" | "media-fallback";

type PendingContinuationState = {
  sourceMessageId: string;
  pendingChunks: string[];
  createdAt: number;
  updatedAt: number;
};

export class WechatBridgeRunner {
  private stopping = false;
  private readonly api: IlinkApiClient;
  private readonly seen = new Map<string, number>();
  private readonly inboundQueues = new Map<string, Promise<void>>();
  private readonly outboundQueues = new Map<string, Promise<void>>();
  private readonly pendingContinuations = new Map<string, PendingContinuationState>();

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
    const handled: Promise<void>[] = [];
    for (const raw of response.msgs ?? []) {
      const message = toInboundWechatMessage(raw);
      if (!message || this.isDuplicate(message)) continue;
      const handledMessage = this.handleMessage(message).catch(async (error) => {
        await this.options.logger.error("message handling failed", error);
      });
      handled.push(handledMessage);
      void handledMessage;
    }

    if (response.get_updates_buf) {
      if (handled.length === 0) {
        await this.options.store.writeJson("sync_cursor.json", { cursor: response.get_updates_buf });
      } else {
        void Promise.allSettled(handled).then(async () => {
          await this.options.store.writeJson("sync_cursor.json", { cursor: response.get_updates_buf });
        }).catch(async (error) => {
          await this.options.logger.warn("failed to advance sync cursor after handling messages", describeError(error));
        });
      }
    }
  }

  private async handleMessage(message: InboundWechatMessage): Promise<void> {
    await this.enqueueInbound(message.userId, async () => {
      await this.handleMessageNow(message);
    });
  }

  private async handleMessageNow(message: InboundWechatMessage): Promise<void> {
    if (!(await this.isAllowedOwner(message.userId))) {
      await this.options.logger.warn("rejected message from non-owner", { userId: message.userId });
      return;
    }

    if (message.contextToken) {
      const tokens = await this.options.store.readJson<ContextTokenMap>("context_tokens.json", {});
      tokens[message.userId] = message.contextToken;
      await this.options.store.writeJson("context_tokens.json", tokens);
    }

    const contextToken = message.contextToken || (await this.options.store.readJson<ContextTokenMap>("context_tokens.json", {}))[message.userId];
    if (!contextToken) {
      await this.options.logger.warn("missing context token; cannot reply", { userId: message.userId });
      return;
    }

    if (await this.tryHandleContinuationShortcut(message, contextToken)) {
      return;
    }
    if (this.hasPendingContinuation(message.userId) && !this.isPureContinueRequest(message)) {
      this.clearPendingContinuation(message.userId);
    }
    const delivery: DeliveryContext = {
      userId: message.userId,
      contextToken,
      messageId: message.id,
      startedAt: Date.now(),
      degraded: false,
      sentMessageCount: 0,
      budgetStopLogged: false
    };
    await this.maybeSendWelcome(delivery);

    await this.options.logger.info("received wechat text", {
      userId: message.userId,
      messageId: message.id,
      command: commandName(message.content),
      length: message.content.length,
      imageCount: message.images?.length ?? 0,
      fileCount: message.files?.length ?? 0
    });

    const progress = this.createProgressSender(message.userId, contextToken, delivery, "stream");
    const longTaskKeepalive = this.createLongTaskKeepalive(progress);
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
        onDelta: (delta) => {
          longTaskKeepalive.markActivity();
          progress.push(delta);
        },
        onApproval: async (request) => {
          longTaskKeepalive.markActivity();
          await progress.sendNotice(request.summary);
        },
        onImageOutput: async (output) => {
          longTaskKeepalive.markActivity();
          await this.sendImageOutput(delivery, output);
          deliveredNativeOutput = true;
        },
        onFileOutput: async (output) => {
          longTaskKeepalive.markActivity();
          await this.sendFileOutput(delivery, output);
          deliveredNativeOutput = true;
        }
      });
    } catch (error) {
      reply = `Bridge error: ${describeError(error)}`;
      await this.options.logger.error("router failed", error);
    } finally {
      longTaskKeepalive.stop();
    }

    await progress.flushAll();
    if (typeof progress.hasTerminalDeliveryFailure === "function" && progress.hasTerminalDeliveryFailure()) {
      delivery.degraded = true;
    }
    let sentIncompleteFallback = false;
    if ((delivery.degraded || progress.hasDeliveryFailure()) && reply) {
      if (typeof progress.hasLocalStopFailure === "function" && progress.hasLocalStopFailure() && progress.hasStreamedOutput()) {
        const remainingReplyChunks = await this.remainingReplyChunks(progress, reply);
        if (remainingReplyChunks.length > 0) {
          sentIncompleteFallback = await this.sendChunkSequenceWithContinuation(
            delivery,
            remainingReplyChunks,
            "fallback",
            delivery.messageId,
            "Codex 已完成。"
          );
        } else {
          sentIncompleteFallback = true;
        }
      } else {
        sentIncompleteFallback = await this.sendTextWithContinuation(
          delivery,
          `流式回传不完整，下面是完整回复：\n\n${reply}`,
          "fallback"
        );
      }
      if (!sentIncompleteFallback) {
        return;
      }
    }
    if (delivery.degraded) {
      return;
    }
    if (progress.hasStreamedOutput()) {
      await progress.sendNotice("Codex 已完成。");
    } else if (reply && !sentIncompleteFallback && !(deliveredNativeOutput && reply === CODEX_NO_TEXT_OUTPUT_MESSAGE)) {
      const completed = await this.sendTextWithContinuation(delivery, reply, "fallback");
      if (!completed) {
        return;
      }
    }
  }

  async handleCodexTaskError(message: string, code?: string): Promise<void> {
    await this.options.logger.warn("codex task error surfaced from session", { message, code });
    await this.options.router.notifyCodexTaskError(message, code);
  }

  private createProgressSender(userId: string, contextToken: string, delivery?: DeliveryContext, phase: DeliveryPhase = "stream"): ProgressSender {
    const context = delivery ?? {
      userId,
      contextToken,
      messageId: "",
      startedAt: Date.now(),
      degraded: false,
      sentMessageCount: 0,
      budgetStopLogged: false
    } satisfies DeliveryContext;
    return new ProgressSender({
      send: (text) => this.sendText(context, text, phase),
      logger: this.options.logger,
      minSendIntervalMs: this.options.progressSendIntervalMs
    });
  }

  private async sendText(delivery: DeliveryContext, text: string, phase: DeliveryPhase): Promise<void>;
  private async sendText(userId: string, contextToken: string, text: string): Promise<void>;
  private async sendText(deliveryOrUserId: DeliveryContext | string, textOrContextToken: string, phaseOrText: DeliveryPhase | string): Promise<void> {
    const delivery = typeof deliveryOrUserId === "string"
      ? {
          userId: deliveryOrUserId,
          contextToken: textOrContextToken,
          messageId: "",
          startedAt: Date.now(),
          degraded: false,
          sentMessageCount: 0,
          budgetStopLogged: false
        } satisfies DeliveryContext
      : deliveryOrUserId;
    const text = typeof deliveryOrUserId === "string" ? phaseOrText : textOrContextToken;
    const phase = typeof deliveryOrUserId === "string" ? "stream" : phaseOrText as DeliveryPhase;
    this.assertSendBudget(delivery, phase, text.length);
    await this.enqueueOutbound(delivery.userId, async () => {
      const clientId = `cwb-${randomBytes(6).toString("hex")}`;
      try {
        await this.api.sendText(delivery.userId, text, delivery.contextToken, clientId);
        this.noteSuccessfulSend(delivery);
      } catch (error) {
        await this.logSendFailure(delivery, phase, text, clientId, error);
        throw error;
      }
    });
  }

  private async sendTextReliably(delivery: DeliveryContext, text: string, phase: DeliveryPhase): Promise<void>;
  private async sendTextReliably(userId: string, contextToken: string, text: string): Promise<void>;
  private async sendTextReliably(deliveryOrUserId: DeliveryContext | string, textOrContextToken: string, phaseOrText: DeliveryPhase | string): Promise<void> {
    const delivery = typeof deliveryOrUserId === "string"
      ? {
          userId: deliveryOrUserId,
          contextToken: textOrContextToken,
          messageId: "",
          startedAt: Date.now(),
          degraded: false,
          sentMessageCount: 0,
          budgetStopLogged: false
        } satisfies DeliveryContext
      : deliveryOrUserId;
    const text = typeof deliveryOrUserId === "string" ? phaseOrText : textOrContextToken;
    const phase = typeof deliveryOrUserId === "string" ? "fallback" : phaseOrText as DeliveryPhase;
    const sender = new ProgressSender({
      send: (chunk) => this.sendText(delivery, chunk, phase),
      logger: this.options.logger,
      minSendIntervalMs: this.options.reliableSendIntervalMs ?? 400
    });
    sender.push(text);
    await sender.flushAll();
    if (sender.hasTerminalDeliveryFailure()) {
      delivery.degraded = true;
    }
    if (sender.hasAnyDeliveryFailure()) {
      throw new Error("failed to fully deliver text reply");
    }
  }

  private async sendTextWithContinuation(delivery: DeliveryContext, text: string, phase: DeliveryPhase): Promise<boolean> {
    const chunks = await chunkTextForWechat(text);
    const remainingSlots = WECHAT_CONTEXT_MAX_SENDS - delivery.sentMessageCount;
    if (chunks.length <= remainingSlots) {
      await this.sendTextReliably(delivery, text, phase);
      this.clearPendingContinuation(delivery.userId);
      return true;
    }
    return await this.sendChunkSequenceWithContinuation(delivery, chunks, phase, delivery.messageId);
  }

  private async remainingReplyChunks(progress: ProgressSender, reply: string): Promise<string[]> {
    const chunks = await chunkTextForWechat(reply);
    const successfulChunks = progress.successfulProgressChunks();
    return chunks.slice(successfulChunks);
  }

  private async sendStartupWelcomeIfPossible(): Promise<void> {
    const owner = this.ownerUserId();
    if (!owner) return;
    const tokens = await this.options.store.readJson<ContextTokenMap>("context_tokens.json", {});
    const token = tokens[owner];
    if (!token) return;
    await this.maybeSendWelcome({
      userId: owner,
      contextToken: token,
      messageId: "startup",
      startedAt: Date.now(),
      degraded: false,
      sentMessageCount: 0,
      budgetStopLogged: false
    });
  }

  private async maybeSendWelcome(delivery: DeliveryContext): Promise<void>;
  private async maybeSendWelcome(userId: string, contextToken: string): Promise<void>;
  private async maybeSendWelcome(deliveryOrUserId: DeliveryContext | string, contextToken?: string): Promise<void> {
    const baseDelivery = typeof deliveryOrUserId === "string"
      ? {
          userId: deliveryOrUserId,
          contextToken: contextToken ?? "",
          messageId: "welcome",
          startedAt: Date.now(),
          degraded: false,
          sentMessageCount: 0,
          budgetStopLogged: false
        } satisfies DeliveryContext
      : deliveryOrUserId;
    const state = await this.options.store.readJson<WelcomeState>("welcome-state.json", {});
    if (welcomeVersionForUser(state, baseDelivery.userId) >= WELCOME_MESSAGE_VERSION) return;
    const welcomeDelivery: DeliveryContext = {
      userId: baseDelivery.userId,
      contextToken: baseDelivery.contextToken,
      messageId: "welcome",
      startedAt: Date.now(),
      degraded: false,
      sentMessageCount: 0,
      budgetStopLogged: false
    };
    await this.sendTextReliably(welcomeDelivery, welcomeMessage(), "notice");
    await this.options.store.writeJson("welcome-state.json", {
      version: WELCOME_MESSAGE_VERSION,
      sentTo: {
        ...(state.sentTo ?? {}),
        [baseDelivery.userId]: WELCOME_MESSAGE_VERSION
      }
    });
  }

  private async sendImageOutput(delivery: DeliveryContext, output: CodexImageOutput): Promise<void> {
    if (delivery.degraded) return;
    try {
      const bytes = await this.loadOutputImageBytes(output);
      await this.sendImage(delivery, bytes);
    } catch (error) {
      await this.options.logger.warn("failed to send native wechat image output", {
        error: describeError(error),
        hasPath: Boolean(output.path),
        hasUrl: Boolean(output.url)
      });
      if (!delivery.degraded) {
        await this.sendTextReliably(delivery, output.fallbackText, "media-fallback");
      }
    }
  }

  private async sendFileOutput(delivery: DeliveryContext, output: CodexFileOutput): Promise<void> {
    if (delivery.degraded) return;
    try {
      const bytes = await readFile(output.path);
      await this.sendFile(delivery, fileNameFromPath(output.path), bytes);
    } catch (error) {
      await this.options.logger.warn("failed to send native wechat file output", {
        error: describeError(error),
        path: output.path
      });
      if (!delivery.degraded) {
        await this.sendTextReliably(delivery, output.fallbackText, "media-fallback");
      }
    }
  }

  private createLongTaskKeepalive(progress: ProgressSender): { markActivity: () => void; stop: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (stopped) return;
        void progress.sendNotice(LONG_TASK_KEEPALIVE_MESSAGE)
          .catch(async (error) => {
            await this.options.logger.warn("failed to send long-task keepalive", describeError(error));
          })
          .finally(() => {
            schedule();
          });
      }, LONG_TASK_KEEPALIVE_INTERVAL_MS);
      timer.unref?.();
    };

    schedule();
    return {
      markActivity: () => {
        schedule();
      },
      stop: () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
    };
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

  private async sendImage(delivery: DeliveryContext, bytes: Buffer): Promise<void> {
    await this.enqueueOutbound(delivery.userId, async () => {
      this.assertSendBudget(delivery, "fallback", bytes.length);
      const clientId = `cwb-img-${randomBytes(6).toString("hex")}`;
      try {
        await this.api.sendImage(delivery.userId, bytes, delivery.contextToken, clientId);
        this.noteSuccessfulSend(delivery);
      } catch (error) {
        await this.logSendFailure(delivery, "stream", `[image:${bytes.length}]`, clientId, error);
        throw error;
      }
    });
  }

  private async sendFile(delivery: DeliveryContext, fileName: string, bytes: Buffer): Promise<void> {
    await this.enqueueOutbound(delivery.userId, async () => {
      this.assertSendBudget(delivery, "fallback", bytes.length);
      const clientId = `cwb-file-${randomBytes(6).toString("hex")}`;
      try {
        await this.api.sendFile(delivery.userId, fileName, bytes, delivery.contextToken, clientId);
        this.noteSuccessfulSend(delivery);
      } catch (error) {
        await this.logSendFailure(delivery, "stream", `[file:${fileName}:${bytes.length}]`, clientId, error);
        throw error;
      }
    });
  }

  private async logSendFailure(delivery: DeliveryContext, phase: DeliveryPhase, text: string, clientId: string, error: unknown): Promise<void> {
    const message = describeError(error);
    if (message.includes("ret=-2")) {
      delivery.degraded = true;
    }
    await this.options.logger.warn("wechat send failed", {
      ...this.deliveryLogMeta(delivery, phase),
      clientId,
      textLength: text.length,
      error: message,
      suspectedStaleContext: message.includes("ret=-2") && Date.now() - delivery.startedAt >= 60_000
    });
  }

  private deliveryLogMeta(delivery: DeliveryContext, phase: DeliveryPhase): Record<string, unknown> {
    return {
      userId: delivery.userId,
      messageId: delivery.messageId,
      phase,
      contextTokenHash: shortHash(delivery.contextToken),
      turnAgeMs: Date.now() - delivery.startedAt,
      degraded: delivery.degraded,
      sentMessageCount: delivery.sentMessageCount
    };
  }

  private assertSendBudget(delivery: DeliveryContext, phase: DeliveryPhase, textLength: number): void {
    if (this.isSendBudgetExempt(delivery, phase)) {
      return;
    }
    const remaining = WECHAT_CONTEXT_MAX_SENDS - delivery.sentMessageCount;
    const reserved = this.reservedSendSlotsForPhase(phase);
    if (remaining > reserved) {
      return;
    }
    if (!delivery.budgetStopLogged) {
      delivery.budgetStopLogged = true;
      void this.options.logger.warn("wechat send budget reached", {
        ...this.deliveryLogMeta(delivery, phase),
        textLength,
        remainingSlots: remaining,
        reservedTailSlots: reserved
      });
    }
    throw new Error(WECHAT_CONTEXT_BUDGET_EXCEEDED);
  }

  private reservedSendSlotsForPhase(phase: DeliveryPhase): number {
    switch (phase) {
      case "completion":
        return 0;
      case "stream":
      case "notice":
        return 1;
      case "fallback":
      case "media-fallback":
        return 0;
    }
  }

  private isSendBudgetExempt(delivery: DeliveryContext, phase: DeliveryPhase): boolean {
    return phase === "notice" && delivery.messageId === "welcome";
  }

  private noteSuccessfulSend(delivery: DeliveryContext): void {
    delivery.sentMessageCount += 1;
  }

  private async sendChunkSequenceWithContinuation(
    delivery: DeliveryContext,
    chunks: string[],
    phase: DeliveryPhase,
    sourceMessageId: string,
    completionNoticeText?: string
  ): Promise<boolean> {
    const originalChunkCount = chunks.length;
    let remainingChunks = chunks.slice();
    while (remainingChunks.length > 0) {
      const remainingSlots = WECHAT_CONTEXT_MAX_SENDS - delivery.sentMessageCount;
      const completionReserve = completionNoticeText ? 1 : 0;
      if (remainingChunks.length <= remainingSlots - completionReserve) {
        const sendResult = await this.trySendChunkBatch(delivery, remainingChunks, phase);
        if (sendResult === true) {
          this.clearPendingContinuation(delivery.userId);
          if (completionNoticeText) {
            try {
              await this.sendText(delivery, completionNoticeText, "completion");
            } catch (error) {
              await this.options.logger.warn("failed to send continuation completion notice", {
                userId: delivery.userId,
                messageId: delivery.messageId,
                sourceMessageId,
                error: describeError(error)
              });
            }
          }
          await this.options.logger.info("continuation delivery completed", {
            userId: delivery.userId,
            messageId: delivery.messageId,
            sourceMessageId,
            deliveredChunkCount: originalChunkCount
          });
          return true;
        }
        this.setPendingContinuation(delivery.userId, sourceMessageId, sendResult.pendingChunks);
        await this.options.logger.info("queued reply continuation", {
          userId: delivery.userId,
          messageId: delivery.messageId,
          sourceMessageId,
          pendingChunkCount: sendResult.pendingChunks.length
        });
        return false;
      }

      const contentSlots = Math.max(remainingSlots - 1, 0);
      const sendNow = contentSlots > 0 ? remainingChunks.slice(0, contentSlots) : [];
      const leftoverAfterPrompt = remainingChunks.slice(sendNow.length);
      const sendResult = await this.trySendChunkBatch(delivery, sendNow, phase);
      if (sendResult !== true) {
        this.setPendingContinuation(delivery.userId, sourceMessageId, sendResult.pendingChunks.concat(leftoverAfterPrompt));
        await this.options.logger.info("queued reply continuation", {
          userId: delivery.userId,
          messageId: delivery.messageId,
          sourceMessageId,
          pendingChunkCount: sendResult.pendingChunks.length + leftoverAfterPrompt.length
        });
        return false;
      }
      this.setPendingContinuation(delivery.userId, sourceMessageId, leftoverAfterPrompt);
      await this.options.logger.info("queued reply continuation", {
        userId: delivery.userId,
        messageId: delivery.messageId,
        sourceMessageId,
        pendingChunkCount: leftoverAfterPrompt.length
      });
      await this.trySendContinuationPrompt(delivery);
      return false;
    }
    this.clearPendingContinuation(delivery.userId);
    return true;
  }

  private async trySendChunkBatch(
    delivery: DeliveryContext,
    chunks: string[],
    phase: DeliveryPhase
  ): Promise<true | { pendingChunks: string[] }> {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      try {
        await this.sendText(delivery, chunk, phase);
      } catch (error) {
        const errorText = describeError(error);
        if (isRecoverableContinuationFailure(errorText)) {
          return { pendingChunks: chunks.slice(index) };
        }
        throw error;
      }
    }
    return true;
  }

  private async trySendContinuationPrompt(delivery: DeliveryContext): Promise<void> {
    try {
      await this.sendText(delivery, CONTINUATION_PROMPT_MESSAGE, "fallback");
    } catch (error) {
      await this.options.logger.warn("failed to send continuation prompt", {
        ...this.deliveryLogMeta(delivery, "fallback"),
        error: describeError(error)
      });
    }
  }

  private async tryHandleContinuationShortcut(message: InboundWechatMessage, contextToken: string): Promise<boolean> {
    if (!this.isPureContinueRequest(message)) {
      return false;
    }
    const hadPendingContinuation = this.pendingContinuations.has(message.userId);
    const continuation = this.getPendingContinuation(message.userId);
    if (!continuation) {
      if (hadPendingContinuation) {
        const delivery: DeliveryContext = {
          userId: message.userId,
          contextToken,
          messageId: message.id,
          startedAt: Date.now(),
          degraded: false,
          sentMessageCount: 0,
          budgetStopLogged: false
        };
        await this.sendTextReliably(delivery, CONTINUATION_EXPIRED_MESSAGE, "fallback");
        return true;
      }
      return false;
    }
    const routerStatus = await this.currentRouterStatus();
    if (routerStatus?.state === "awaiting_approval") {
      return false;
    }
    const delivery: DeliveryContext = {
      userId: message.userId,
      contextToken,
      messageId: message.id,
      startedAt: Date.now(),
      degraded: false,
      sentMessageCount: 0,
      budgetStopLogged: false
    };
    await this.options.logger.info("received continuation shortcut", {
      userId: message.userId,
      messageId: message.id,
      sourceMessageId: continuation.sourceMessageId,
      remainingChunkCount: continuation.pendingChunks.length
    });
    const completed = await this.sendChunkSequenceWithContinuation(
      delivery,
      continuation.pendingChunks,
      "fallback",
      continuation.sourceMessageId,
      "Codex 已完成。"
    );
    if (!completed) {
      return true;
    }
    return true;
  }

  private async currentRouterStatus(): Promise<{ state: string } | null> {
    const router = this.options.router as SessionRouter & {
      codexStatus?: () => Promise<{ state: string }>;
    };
    if (typeof router.codexStatus !== "function") {
      return null;
    }
    return await router.codexStatus();
  }

  private isPureContinueRequest(message: InboundWechatMessage): boolean {
    return message.content.trim() === "1"
      && (message.images?.length ?? 0) === 0
      && (message.files?.length ?? 0) === 0;
  }

  private hasPendingContinuation(userId: string): boolean {
    return this.getPendingContinuation(userId) !== null;
  }

  private getPendingContinuation(userId: string): PendingContinuationState | null {
    const continuation = this.pendingContinuations.get(userId);
    if (!continuation) {
      return null;
    }
    if (Date.now() - continuation.updatedAt > CONTINUATION_STATE_TTL_MS) {
      this.pendingContinuations.delete(userId);
      return null;
    }
    return continuation;
  }

  private setPendingContinuation(userId: string, sourceMessageId: string, pendingChunks: string[]): void {
    if (pendingChunks.length === 0) {
      this.pendingContinuations.delete(userId);
      return;
    }
    const now = Date.now();
    const existing = this.pendingContinuations.get(userId);
    this.pendingContinuations.set(userId, {
      sourceMessageId,
      pendingChunks,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
  }

  private clearPendingContinuation(userId: string): void {
    this.pendingContinuations.delete(userId);
  }

  private async enqueueOutbound(userId: string, send: () => Promise<void>): Promise<void> {
    const previous = this.outboundQueues.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(send);
    this.outboundQueues.set(userId, next);
    try {
      await next;
    } finally {
      if (this.outboundQueues.get(userId) === next) {
        this.outboundQueues.delete(userId);
      }
    }
  }

  private async enqueueInbound(userId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.inboundQueues.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.inboundQueues.set(userId, next);
    try {
      await next;
    } finally {
      if (this.inboundQueues.get(userId) === next) {
        this.inboundQueues.delete(userId);
      }
    }
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

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function isRecoverableContinuationFailure(errorText: string): boolean {
  const normalized = errorText.toLowerCase();
  return normalized.includes("ret=-2") || normalized.includes(WECHAT_CONTEXT_BUDGET_EXCEEDED);
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
    helpMessage(),
    "",
    "发送 /help 可随时再看这份说明。"
  ].join("\n");
}

function welcomeVersionForUser(state: WelcomeState, userId: string): number {
  const value = state.sentTo?.[userId];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === true) return 1;
  return 0;
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

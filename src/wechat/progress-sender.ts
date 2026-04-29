import { setTimeout as delay } from "node:timers/promises";

export type ProgressSenderOptions = {
  send: (text: string) => Promise<void>;
  logger: {
    warn: (message: string, data?: unknown) => Promise<void>;
  };
  maxMessageLength?: number;
  minSendIntervalMs?: number;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export class ProgressSender {
  private buffer = "";
  private streamedOutput = false;
  private deliveryFailed = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly maxMessageLength: number;
  private readonly minSendIntervalMs: number;
  private readonly retryDelaysMs: number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private nextSendAllowedAt = 0;

  constructor(private readonly options: ProgressSenderOptions) {
    this.maxMessageLength = options.maxMessageLength ?? 1200;
    this.minSendIntervalMs = options.minSendIntervalMs ?? 900;
    this.retryDelaysMs = options.retryDelaysMs ?? [400, 1200, 2500];
    this.sleep = options.sleep ?? ((ms) => delay(ms).then(() => undefined));
    this.now = options.now ?? (() => Date.now());
  }

  hasStreamedOutput(): boolean {
    return this.streamedOutput;
  }

  hasDeliveryFailure(): boolean {
    return this.deliveryFailed;
  }

  sendNotice(text: string): Promise<void> {
    return this.enqueue(text, false);
  }

  push(delta: string): void {
    this.buffer += delta;
    this.flushReadyChunks(false);
  }

  async settle(): Promise<void> {
    await this.queue;
  }

  async flushAll(): Promise<void> {
    this.flushReadyChunks(true);
    while (this.buffer.trim()) {
      this.flushOne(this.takeFallbackChunk());
    }
    await this.queue;
  }

  private flushReadyChunks(final: boolean): void {
    let chunk = this.takeReadyChunk(final);
    while (chunk) {
      this.flushOne(chunk);
      chunk = this.takeReadyChunk(final);
    }
  }

  private flushOne(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.enqueue(trimmed, true);
  }

  private takeReadyChunk(final: boolean): string {
    this.trimLeadingSpace();
    if (!this.buffer.trim()) {
      this.buffer = "";
      return "";
    }

    const codeBlockEnd = findFirstClosedFenceEnd(this.buffer);
    if (codeBlockEnd > 0) {
      return this.take(codeBlockEnd);
    }

    if (isInsideFence(this.buffer)) {
      return final ? this.takeFallbackChunk() : "";
    }

    const paragraphEnd = findParagraphEnd(this.buffer);
    if (paragraphEnd > 0) {
      return this.take(paragraphEnd);
    }

    const sentenceEnd = findSentenceEnd(this.buffer);
    if (sentenceEnd > 0) {
      return this.take(sentenceEnd);
    }

    if (this.buffer.length >= this.maxMessageLength) {
      return this.takeNaturalBoundaryNear(this.maxMessageLength);
    }

    if (final) return this.takeFallbackChunk();
    return "";
  }

  private takeFallbackChunk(): string {
    if (this.buffer.length <= this.maxMessageLength) return this.take(this.buffer.length);
    return this.takeNaturalBoundaryNear(this.maxMessageLength);
  }

  private takeNaturalBoundaryNear(limit: number): string {
    const bounded = this.buffer.slice(0, limit);
    let splitAt = bounded.lastIndexOf("\n");
    if (splitAt < Math.floor(limit * 0.35)) splitAt = lastSentenceBoundary(bounded);
    if (splitAt < Math.floor(limit * 0.35)) splitAt = bounded.lastIndexOf(" ");
    if (splitAt < Math.floor(limit * 0.35)) splitAt = limit - 1;
    return this.take(splitAt + 1);
  }

  private take(length: number): string {
    const text = this.buffer.slice(0, length);
    this.buffer = this.buffer.slice(length);
    this.trimLeadingSpace();
    return text;
  }

  private trimLeadingSpace(): void {
    this.buffer = this.buffer.replace(/^\s+/, "");
  }

  private enqueue(text: string, countsAsProgress: boolean): Promise<void> {
    this.queue = this.queue
      .then(() => this.deliver(text, countsAsProgress))
      .catch(async (error) => {
        await this.options.logger.warn("failed to send progress chunk", describeError(error));
      });
    return this.queue;
  }

  private async deliver(text: string, countsAsProgress: boolean): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const sent = await this.tryDeliver(trimmed, countsAsProgress);
    if (!sent) {
      if (countsAsProgress) this.deliveryFailed = true;
      await this.options.logger.warn("dropping undeliverable progress chunk", {
        length: trimmed.length,
        preview: trimmed.slice(0, 120)
      });
    }
  }

  private async tryDeliver(text: string, countsAsProgress: boolean): Promise<boolean> {
    const sendResult = await this.sendWithRetry(text);
    if (sendResult === true) {
      if (countsAsProgress) this.streamedOutput = true;
      return true;
    }

    await this.options.logger.warn("failed to send progress chunk", {
      error: sendResult,
      length: text.length
    });

    if (!shouldSplitAfterFailure(sendResult, text)) {
      return false;
    }

    const parts = splitChunkForRetry(text, retrySplitLimit(text));
    if (parts.length <= 1) {
      return false;
    }

    await this.options.logger.warn("retrying progress chunk by splitting", {
      originalLength: text.length,
      partLengths: parts.map((part) => part.length)
    });

    for (const part of parts) {
      const delivered = await this.tryDeliver(part, countsAsProgress);
      if (!delivered) return false;
    }
    return true;
  }

  private async sendWithRetry(text: string): Promise<true | string> {
    let lastError = "";
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      try {
        await this.waitForSendWindow();
        await this.options.send(text);
        this.markSendWindow();
        return true;
      } catch (error) {
        this.markSendWindow();
        lastError = describeError(error);
        if (attempt >= this.retryDelaysMs.length || !isRetryableSendFailure(lastError)) {
          return lastError;
        }
        const delayMs = this.retryDelaysMs[attempt] ?? 0;
        await this.options.logger.warn("retrying progress chunk send", {
          attempt: attempt + 1,
          delayMs,
          error: lastError,
          length: text.length
        });
        await this.sleep(delayMs);
      }
    }
    return lastError || "unknown progress send failure";
  }

  private async waitForSendWindow(): Promise<void> {
    const delayMs = this.nextSendAllowedAt - this.now();
    if (delayMs > 0) {
      await this.sleep(delayMs);
    }
  }

  private markSendWindow(): void {
    this.nextSendAllowedAt = this.now() + this.minSendIntervalMs;
  }
}

function findParagraphEnd(text: string): number {
  const match = /\n\s*\n/.exec(text);
  return match ? match.index : -1;
}

function findSentenceEnd(text: string): number {
  const boundary = lastSentenceBoundary(text);
  if (boundary < 0) return -1;
  return boundary + 1;
}

function lastSentenceBoundary(text: string): number {
  const match = /[。！？!?](?=\s|$)|\.(?=\s|$)/.exec(text);
  return match ? match.index : -1;
}

function findFirstClosedFenceEnd(text: string): number {
  const start = text.indexOf("```");
  if (start < 0) return -1;
  const end = text.indexOf("```", start + 3);
  return end < 0 ? -1 : end + 3;
}

function isInsideFence(text: string): boolean {
  const matches = text.match(/```/g);
  return Boolean(matches && matches.length % 2 === 1);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableSendFailure(errorText: string): boolean {
  const normalized = errorText.toLowerCase();
  return normalized.includes("fetch failed")
    || normalized.includes("aborted")
    || normalized.includes("timeout")
    || normalized.includes("http 5")
    || normalized.includes("ret=-2");
}

function shouldSplitAfterFailure(errorText: string, text: string): boolean {
  if (text.length <= 1) return false;
  const normalized = errorText.toLowerCase();
  return normalized.includes("ret=-2")
    || normalized.includes("parameter")
    || normalized.includes("too large")
    || normalized.includes("payload");
}

function retrySplitLimit(text: string): number {
  if (text.length <= 8) return Math.max(1, text.length - 1);
  return Math.max(8, Math.floor(text.length / 2));
}

function splitChunkForRetry(text: string, limit: number): string[] {
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    const splitAt = chooseRetrySplitPoint(remaining, limit);
    if (splitAt <= 0 || splitAt >= remaining.length) break;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts.filter(Boolean);
}

function chooseRetrySplitPoint(text: string, limit: number): number {
  const bounded = text.slice(0, limit);
  let splitAt = bounded.lastIndexOf("\n");
  if (splitAt < Math.floor(limit * 0.35)) {
    const boundary = lastSentenceBoundary(bounded);
    splitAt = boundary >= 0 ? boundary + 1 : splitAt;
  }
  if (splitAt < Math.floor(limit * 0.35)) {
    const space = bounded.lastIndexOf(" ");
    splitAt = space >= 0 ? space + 1 : splitAt;
  }
  if (splitAt < 1) splitAt = limit;
  return splitAt;
}

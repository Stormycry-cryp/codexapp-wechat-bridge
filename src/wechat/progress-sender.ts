export type ProgressSenderOptions = {
  send: (text: string) => Promise<void>;
  logger: {
    warn: (message: string, data?: unknown) => Promise<void>;
  };
  maxMessageLength?: number;
};

export class ProgressSender {
  private buffer = "";
  private streamedOutput = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly maxMessageLength: number;

  constructor(private readonly options: ProgressSenderOptions) {
    this.maxMessageLength = options.maxMessageLength ?? 1200;
  }

  hasStreamedOutput(): boolean {
    return this.streamedOutput;
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
      .then(async () => {
        await this.options.send(text);
        if (countsAsProgress) this.streamedOutput = true;
      })
      .catch(async (error) => {
        await this.options.logger.warn("failed to send progress chunk", describeError(error));
      });
    return this.queue;
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

import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type JsonLineServerRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};

export class JsonLineRpcClient extends EventEmitter {
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number | string, PendingRequest>();

  constructor(private readonly input: Writable, output: Readable) {
    super();
    output.on("data", (chunk: Buffer | string) => this.handleData(chunk.toString()));
    output.on("error", (error) => this.emit("error", error));
    output.on("close", () => this.emit("close"));
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject
      });
    });
    this.input.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  respond(id: number | string, result: unknown): void {
    this.input.write(`${JSON.stringify({ id, result })}\n`);
  }

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleMessage(JSON.parse(trimmed));
    }
  }

  private handleMessage(message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown }): void {
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id != null && message.method) {
      this.emit("request", message.id, message.method, message.params);
      return;
    }
    if (message.method) {
      this.emit("notification", message.method, message.params);
    }
  }
}

import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "./redaction.js";

export class Logger {
  constructor(private readonly dataDir: string, private readonly alsoConsole = true) {}

  async info(message: string, meta?: unknown): Promise<void> {
    await this.write("INFO", message, meta);
  }

  async warn(message: string, meta?: unknown): Promise<void> {
    await this.write("WARN", message, meta);
  }

  async error(message: string, meta?: unknown): Promise<void> {
    await this.write("ERROR", message, meta);
  }

  private async write(level: string, message: string, meta?: unknown): Promise<void> {
    const line = `${new Date().toISOString()} ${level} ${redactSecrets(message)}${meta === undefined ? "" : ` ${redactSecrets(toLogMeta(meta))}`}\n`;
    if (this.alsoConsole) {
      const out = level === "ERROR" ? console.error : console.log;
      out(line.trimEnd());
    }
    const logDir = join(this.dataDir, "logs");
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    await appendFile(join(logDir, "bridge.log"), line, { mode: 0o600 });
  }
}

function toLogMeta(meta: unknown): unknown {
  if (meta instanceof Error) {
    return {
      name: meta.name,
      message: meta.message,
      stack: meta.stack
    };
  }
  return meta;
}

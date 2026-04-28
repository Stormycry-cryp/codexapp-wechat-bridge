import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type StoreFile =
  | "account.json"
  | "sync_cursor.json"
  | "context_tokens.json"
  | "bridge-state.json"
  | "projects.json"
  | "config.json";

export class BridgeStore {
  constructor(readonly dir: string) {}

  path(file: StoreFile | string): string {
    return join(this.dir, file);
  }

  async readJson<T = unknown>(file: StoreFile | string, fallback?: T): Promise<T> {
    try {
      return JSON.parse(await readFile(this.path(file), "utf8")) as T;
    } catch (error) {
      if (fallback !== undefined && isMissingFileError(error)) {
        return fallback;
      }
      throw error;
    }
  }

  async writeJson(file: StoreFile | string, value: unknown): Promise<void> {
    const target = this.path(file);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, target);
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

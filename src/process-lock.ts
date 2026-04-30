import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ProcessLock = {
  release: () => Promise<void>;
};

export async function acquireProcessLock(dataDir: string): Promise<ProcessLock> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, "bridge.lock");
  const pidPath = join(dataDir, "bridge.pid");
  const existingPid = await readExistingPid(lockPath);
  if (existingPid && isProcessAlive(existingPid)) {
    throw new Error(`codex-wechat-bridge is already running with pid ${existingPid}`);
  }

  await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600 });
  await writeFile(pidPath, `${process.pid}\n`, { mode: 0o600 });

  return {
    release: async () => {
      const currentPid = await readExistingPid(lockPath);
      if (currentPid === process.pid) {
        await rm(lockPath, { force: true });
      }
    }
  };
}

async function readExistingPid(lockPath: string): Promise<number | null> {
  try {
    const raw = (await readFile(lockPath, "utf8")).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      return error.code === "EPERM";
    }
    return false;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireProcessLock } from "../src/process-lock.js";

describe("acquireProcessLock", () => {
  it("rejects a second active process for the same lock file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-lock-"));
    try {
      const lock = await acquireProcessLock(dir);

      await expect(acquireProcessLock(dir)).rejects.toThrow(/already running/);

      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces a stale lock and writes the current pid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-lock-"));
    try {
      await writeFile(join(dir, "bridge.lock"), "999999\n", { mode: 0o600 });

      const lock = await acquireProcessLock(dir);

      await expect(readFile(join(dir, "bridge.pid"), "utf8")).resolves.toBe(`${process.pid}\n`);
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

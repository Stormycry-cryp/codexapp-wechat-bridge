import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeStore } from "../src/storage.js";

describe("BridgeStore", () => {
  it("persists json state with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-store-"));
    const store = new BridgeStore(dir);

    await store.writeJson("bridge-state.json", { activeThreadId: "thread-1" });

    await expect(store.readJson("bridge-state.json")).resolves.toEqual({ activeThreadId: "thread-1" });
    expect((await stat(join(dir, "bridge-state.json"))).mode & 0o777).toBe(0o600);
  });
});


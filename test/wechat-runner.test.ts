import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { BridgeStore } from "../src/storage.js";
import { WechatBridgeRunner } from "../src/wechat/transport.js";

describe("WechatBridgeRunner onboarding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the usage guide once when the first reply context token is available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const sentTexts: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        sentTexts.push(body.msg.item_list[0].text_item.text);
        return new Response(JSON.stringify({ ret: 0 }));
      }));
      const store = new BridgeStore(dir);
      const runner = new WechatBridgeRunner({
        config: { ...defaultConfig("/work"), ownerUserId: "user@im.wechat", longPollTimeoutMs: 10 },
        account: { token: "token" },
        store,
        router: {
          handleInput: vi.fn(async () => "status ok")
        } as never,
        logger: fakeLogger()
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "1", userId: "user@im.wechat", content: "/status", contextToken: "ctx" });
      await handleMessage({ id: "2", userId: "user@im.wechat", content: "/status", contextToken: "ctx" });

      expect(sentTexts[0]).toContain("Codex 微信桥已连接");
      expect(sentTexts[0]).toContain("/help");
      expect(sentTexts[0]).toContain("停下");
      expect(sentTexts.filter((text) => text.includes("Codex 微信桥已连接"))).toHaveLength(1);
      await expect(store.readJson("welcome-state.json")).resolves.toEqual({
        sentTo: {
          "user@im.wechat": true
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function fakeLogger() {
  return {
    info: vi.fn(async () => {}),
    warn: vi.fn(async () => {}),
    error: vi.fn(async () => {})
  };
}

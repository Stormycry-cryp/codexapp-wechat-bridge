import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { BridgeStore } from "../src/storage.js";
import { encryptWechatCdnPayload } from "../src/wechat/media.js";
import { ProgressSender } from "../src/wechat/progress-sender.js";
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
      expect(sentTexts[0]).toContain("近期更新");
      expect(sentTexts[0]).toContain("/steer <内容>");
      expect(sentTexts.filter((text) => text.includes("Codex 微信桥已连接"))).toHaveLength(1);
      await expect(store.readJson("welcome-state.json")).resolves.toEqual({
        version: 2,
        sentTo: {
          "user@im.wechat": 2
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("re-sends the updated help once when a user only has an older welcome version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const sentTexts: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        sentTexts.push(body.msg.item_list[0].text_item.text);
        return new Response(JSON.stringify({ ret: 0 }));
      }));
      const store = new BridgeStore(dir);
      await store.writeJson("welcome-state.json", {
        version: 1,
        sentTo: {
          "user@im.wechat": 1
        }
      });
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

      await handleMessage({ id: "3", userId: "user@im.wechat", content: "/status", contextToken: "ctx" });
      await handleMessage({ id: "4", userId: "user@im.wechat", content: "/status", contextToken: "ctx" });

      expect(sentTexts.filter((text) => text.includes("Codex 微信桥已连接"))).toHaveLength(1);
      expect(sentTexts[0]).toContain("近期更新");
      await expect(store.readJson("welcome-state.json")).resolves.toEqual({
        version: 2,
        sentTo: {
          "user@im.wechat": 2
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("downloads inbound WeChat files and forwards saved paths to the router", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const router = {
        handleInput: vi.fn(async () => "file ok")
      };
      const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
      const fileBytes = Buffer.from("%PDF-1.4 sample");
      const encrypted = encryptWechatCdnPayload(fileBytes, key);
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=file-param") {
          return new Response(encrypted);
        }
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          return new Response(JSON.stringify({ ret: 0 }));
        }
        throw new Error(`unexpected url: ${url} ${String(init?.method ?? "GET")}`);
      }));
      const store = new BridgeStore(dir);
      const runner = new WechatBridgeRunner({
        config: { ...defaultConfig("/work"), ownerUserId: "user@im.wechat", longPollTimeoutMs: 10 },
        account: { token: "token" },
        store,
        router: router as never,
        logger: fakeLogger()
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: {
          id: string;
          userId: string;
          content: string;
          contextToken: string;
          files: Array<{
            encryptedQueryParam: string;
            aesKeyHex: string;
            fileName: string;
          }>;
        }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({
        id: "9",
        userId: "user@im.wechat",
        content: "",
        contextToken: "ctx",
        files: [{
          encryptedQueryParam: "file-param",
          aesKeyHex: key.toString("hex"),
          fileName: "需求说明.pdf"
        }]
      });

      expect(router.handleInput).toHaveBeenCalledTimes(1);
      const input = router.handleInput.mock.calls[0]?.[0];
      expect(input.text).toBe("");
      expect(input.files).toHaveLength(1);
      expect(input.files[0].originalName).toBe("需求说明.pdf");
      expect(input.files[0].path).toContain("/assets/");
      expect(input.files[0].path).toContain(".pdf");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uploads generated files back to WeChat when Codex produces a workspace artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const uploadedBodies: Buffer[] = [];
      const sentMessages: Array<Record<string, unknown>> = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/getuploadurl") {
          const body = JSON.parse(String(init?.body));
          expect(body.media_type).toBe(3);
          return new Response(JSON.stringify({ upload_param: "upload-file-param" }));
        }
        if (url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=upload-file-param&filekey=")) {
          uploadedBodies.push(Buffer.from(await new Response(init?.body).arrayBuffer()));
          return new Response("", { headers: { "x-encrypted-param": "download-file-param" } });
        }
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          sentMessages.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ ret: 0 }));
        }
        throw new Error(`unexpected url: ${url} ${String(init?.method ?? "GET")}`);
      }));
      const artifactPath = join(dir, "report.pdf");
      await writeFile(artifactPath, "artifact body");
      const store = new BridgeStore(dir);
      const runner = new WechatBridgeRunner({
        config: { ...defaultConfig("/work"), ownerUserId: "user@im.wechat", longPollTimeoutMs: 10 },
        account: { token: "token" },
        store,
        router: {
          handleInput: vi.fn(async (_input, hooks?: { onFileOutput?: (output: { path: string }) => Promise<void> }) => {
            await hooks?.onFileOutput?.({ path: artifactPath, fallbackText: `文件已生成: ${artifactPath}` });
            return "(Codex completed without text output.)";
          })
        } as never,
        logger: fakeLogger()
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "10", userId: "user@im.wechat", content: "做个 pdf", contextToken: "ctx" });

      expect(uploadedBodies).toHaveLength(1);
      expect(uploadedBodies[0].length).toBeGreaterThan((await readFile(artifactPath)).length);
      const fileMessage = sentMessages.find((message) => Number((message.msg as { item_list?: Array<{ type?: number }> }).item_list?.[0]?.type) === 4);
      expect(fileMessage).toBeTruthy();
      expect(fileMessage?.msg).toMatchObject({
        to_user_id: "user@im.wechat",
        context_token: "ctx",
        item_list: [{
          type: 4,
          file_item: {
            file_name: "report.pdf",
            len: String((await readFile(artifactPath)).length)
          }
        }]
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the complete final reply when streaming split retries only deliver partial text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const sentTexts: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          const body = JSON.parse(String(init?.body));
          const text = body.msg.item_list[0].text_item.text;
          sentTexts.push(text);
          if (!text.startsWith("流式回传不完整") && text.includes("K")) {
            return new Response(JSON.stringify({ ret: -3, errcode: 0, errmsg: "payload too large" }));
          }
          return new Response(JSON.stringify({ ret: 0 }));
        }
        throw new Error(`unexpected url: ${url} ${String(init?.method ?? "GET")}`);
      }));

      const store = new BridgeStore(dir);
      await store.writeJson("welcome-state.json", { version: 2, sentTo: { "user@im.wechat": 2 } });
      const runner = new WechatBridgeRunner({
        config: { ...defaultConfig("/work"), ownerUserId: "user@im.wechat", longPollTimeoutMs: 10 },
        account: { token: "token" },
        store,
        router: {
          handleInput: vi.fn(async (_input, hooks?: { onDelta?: (delta: string) => void }) => {
            hooks?.onDelta?.("ABCDEFGHIJKLMN");
            return "ABCDEFGHIJKLMN";
          })
        } as never,
        logger: fakeLogger()
      });
      vi.spyOn(runner as unknown as {
        createProgressSender(userId: string, contextToken: string): ProgressSender;
      }, "createProgressSender").mockImplementation((userId, contextToken) => new ProgressSender({
        send: async (text) => {
          await (runner as unknown as {
            sendText(userId: string, contextToken: string, text: string): Promise<void>;
          }).sendText(userId, contextToken, text);
        },
        logger: fakeLogger(),
        minSendIntervalMs: 0,
        retryDelaysMs: [],
        sleep: async () => {}
      }));
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "11", userId: "user@im.wechat", content: "stream please", contextToken: "ctx" });

      expect(sentTexts).toContain("流式回传不完整，下面是完整回复：\n\nABCDEFGHIJKLMN");
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

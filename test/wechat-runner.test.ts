import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { BridgeStore } from "../src/storage.js";
import { CODEX_NO_TEXT_OUTPUT_MESSAGE } from "../src/codex/app-server-client.js";
import { encryptWechatCdnPayload } from "../src/wechat/media.js";
import { ProgressSender } from "../src/wechat/progress-sender.js";
import { WechatBridgeRunner } from "../src/wechat/transport.js";

describe("WechatBridgeRunner onboarding", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
        logger: fakeLogger(),
        reliableSendIntervalMs: 0
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "1", userId: "user@im.wechat", content: "/status", contextToken: "ctx" });
      await handleMessage({ id: "2", userId: "user@im.wechat", content: "/status", contextToken: "ctx" });

      const combined = sentTexts.join("\n");
      expect(combined).toContain("Codex 微信桥已连接");
      expect(combined).toContain("/help");
      expect(combined).toContain("停下");
      expect(combined).toContain("近期更新");
      expect(combined).toContain("/steer <内容>");
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
        logger: fakeLogger(),
        reliableSendIntervalMs: 0
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "3", userId: "user@im.wechat", content: "/status", contextToken: "ctx" });
      await handleMessage({ id: "4", userId: "user@im.wechat", content: "/status", contextToken: "ctx" });

      const combined = sentTexts.join("\n");
      expect(sentTexts.filter((text) => text.includes("Codex 微信桥已连接"))).toHaveLength(1);
      expect(combined).toContain("近期更新");
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
        logger: fakeLogger(),
        reliableSendIntervalMs: 0
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
            return CODEX_NO_TEXT_OUTPUT_MESSAGE;
          })
        } as never,
        logger: fakeLogger(),
        reliableSendIntervalMs: 0
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

  it("serializes streamed text and native file sends for the same WeChat context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      let sendMessageInFlight = false;
      const sentTypes: number[] = [];
      const sentTexts: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/getuploadurl") {
          return new Response(JSON.stringify({ upload_param: "upload-file-param" }));
        }
        if (url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=upload-file-param&filekey=")) {
          return new Response("", { headers: { "x-encrypted-param": "download-file-param" } });
        }
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          if (sendMessageInFlight) {
            return new Response(JSON.stringify({ ret: -2, errcode: 0, errmsg: "overlap" }));
          }
          sendMessageInFlight = true;
          await new Promise((resolve) => setTimeout(resolve, 20));
          sendMessageInFlight = false;
          const body = JSON.parse(String(init?.body));
          const item = body.msg.item_list[0];
          sentTypes.push(Number(item.type));
          if (Number(item.type) === 1) {
            sentTexts.push(item.text_item.text);
          }
          return new Response(JSON.stringify({ ret: 0 }));
        }
        throw new Error(`unexpected url: ${url} ${String(init?.method ?? "GET")}`);
      }));

      const artifactPath = join(dir, "report.txt");
      await writeFile(artifactPath, "artifact body");
      const store = new BridgeStore(dir);
      await store.writeJson("welcome-state.json", { version: 2, sentTo: { "user@im.wechat": 2 } });
      const runner = new WechatBridgeRunner({
        config: { ...defaultConfig("/work"), ownerUserId: "user@im.wechat", longPollTimeoutMs: 10 },
        account: { token: "token" },
        store,
        router: {
          handleInput: vi.fn(async (_input, hooks?: {
            onDelta?: (delta: string) => void;
            onFileOutput?: (output: { path: string; fallbackText: string }) => Promise<void>;
          }) => {
            hooks?.onDelta?.("第一段说明。");
            await hooks?.onFileOutput?.({ path: artifactPath, fallbackText: `文件已生成: ${artifactPath}` });
            hooks?.onDelta?.("第二段补充。");
            return CODEX_NO_TEXT_OUTPUT_MESSAGE;
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

      await handleMessage({ id: "10b", userId: "user@im.wechat", content: "做个 txt", contextToken: "ctx" });

      expect(sentTypes.filter((type) => type === 4)).toHaveLength(1);
      expect(sentTexts).toContain("第一段说明。");
      expect(sentTexts).toContain("第二段补充。");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not start a new inbound turn for the same user until the previous reply has finished sending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      let releaseFirstSend: (() => void) | null = null;
      const firstSendStarted = new Promise<void>((resolve) => {
        releaseFirstSend = resolve;
      });
      const router = {
        handleInput: vi.fn(async ({ text }: { text: string }) => `${text} done`)
      };
      let sendCount = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          sendCount += 1;
          if (sendCount === 1) {
            await firstSendStarted;
          }
          const body = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ ret: 0, echoedText: body.msg.item_list[0].text_item.text }));
        }
        throw new Error(`unexpected url: ${url} ${String(init?.method ?? "GET")}`);
      }));

      const store = new BridgeStore(dir);
      await store.writeJson("welcome-state.json", { version: 2, sentTo: { "user@im.wechat": 2 } });
      const runner = new WechatBridgeRunner({
        config: { ...defaultConfig("/work"), ownerUserId: "user@im.wechat", longPollTimeoutMs: 10 },
        account: { token: "token" },
        store,
        router: router as never,
        logger: fakeLogger()
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      const first = handleMessage({ id: "serial-1", userId: "user@im.wechat", content: "/status", contextToken: "ctx" });
      await vi.waitFor(() => {
        expect(sendCount).toBe(1);
      });

      const second = handleMessage({ id: "serial-2", userId: "user@im.wechat", content: "/threads", contextToken: "ctx" });
      await Promise.resolve();
      expect(router.handleInput).toHaveBeenCalledTimes(1);

      releaseFirstSend?.();
      await first;
      await vi.waitFor(() => {
        expect(router.handleInput).toHaveBeenCalledTimes(2);
      });
      await second;
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
          sentTexts.push(body.msg.item_list[0].text_item.text);
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
      }, "createProgressSender").mockImplementation(() => ({
        sendNotice: vi.fn(async (text: string) => {
          sentTexts.push(text);
        }),
        push: vi.fn(),
        flushAll: vi.fn(async () => {}),
        settle: vi.fn(async () => {}),
        hasDeliveryFailure: vi.fn(() => true),
        hasAnyDeliveryFailure: vi.fn(() => true),
        hasStreamedOutput: vi.fn(() => true)
      } as unknown as ProgressSender));
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "11", userId: "user@im.wechat", content: "stream please", contextToken: "ctx" });

      expect(sentTexts.join("")).toContain("流式回传不完整");
      expect(sentTexts.join("")).toContain("ABCDEFGHIJKLMN");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still attempts the complete fallback reply after a persistent iLink ret=-2 stream failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const attemptedTexts: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          const body = JSON.parse(String(init?.body));
          attemptedTexts.push(body.msg.item_list[0].text_item.text);
          return new Response(JSON.stringify({ ret: -2, errcode: 0, errmsg: "" }));
        }
        throw new Error(`unexpected url: ${url} ${String(init?.method ?? "GET")}`);
      }));
      const logger = fakeLogger();
      const store = new BridgeStore(dir);
      await store.writeJson("welcome-state.json", { version: 2, sentTo: { "user@im.wechat": 2 } });
      const runner = new WechatBridgeRunner({
        config: { ...defaultConfig("/work"), ownerUserId: "user@im.wechat", longPollTimeoutMs: 10 },
        account: { token: "token" },
        store,
        router: {
          handleInput: vi.fn(async (_input, hooks?: { onDelta?: (delta: string) => void }) => {
            hooks?.onDelta?.("第一段说明。");
            return "第一段说明。完整最终回复。";
          })
        } as never,
        logger
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await expect(handleMessage({
        id: "ret2-turn",
        userId: "user@im.wechat",
        content: "stream please",
        contextToken: "ctx"
      })).rejects.toThrow("failed to fully deliver text reply");

      expect(attemptedTexts).toEqual([
        "收到，Codex 开始处理。长任务会分段回传，/stop 可中断。",
        "流式回传不完整，下面是完整回复："
      ]);
      expect(attemptedTexts).not.toContain("Codex 已完成。");
      expect(logger.warn).not.toHaveBeenCalledWith(
        "skipping final fallback after degraded WeChat delivery",
        expect.anything()
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("continues a truncated reply on plain 1 without sending 1 into the router", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const sentTexts: string[] = [];
      const logger = fakeLogger();
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          const body = JSON.parse(String(init?.body));
          sentTexts.push(body.msg.item_list[0].text_item.text);
          return new Response(JSON.stringify({ ret: 0 }));
        }
        throw new Error(`unexpected url: ${url} ${String(init?.method ?? "GET")}`);
      }));

      const paragraphs = Array.from({ length: 12 }, (_, index) => `第${index + 1}段${"说明".repeat(40)}。`);
      const reply = paragraphs.join("\n\n");
      const router = {
        handleInput: vi.fn(async () => reply)
      };
      const store = new BridgeStore(dir);
      await store.writeJson("welcome-state.json", { version: 2, sentTo: { "user@im.wechat": 2 } });
      const runner = new WechatBridgeRunner({
        config: { ...defaultConfig("/work"), ownerUserId: "user@im.wechat", longPollTimeoutMs: 10 },
        account: { token: "token" },
        store,
        router: router as never,
        logger,
        reliableSendIntervalMs: 0
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "continue-1", userId: "user@im.wechat", content: "/long", contextToken: "ctx-a" });
      expect(router.handleInput).toHaveBeenCalledTimes(1);
      expect(sentTexts.filter((text) => text.startsWith("第"))).toHaveLength(9);
      expect(sentTexts.at(-1)).toBe("回复 1 继续");
      expect(logger.info).toHaveBeenCalledWith(
        "queued reply continuation",
        expect.objectContaining({
          userId: "user@im.wechat",
          sourceMessageId: "continue-1",
          pendingChunkCount: 3
        })
      );

      await handleMessage({ id: "continue-2", userId: "user@im.wechat", content: "1", contextToken: "ctx-b" });
      expect(router.handleInput).toHaveBeenCalledTimes(1);
      expect(sentTexts.filter((text) => text.startsWith("第"))).toHaveLength(12);
      expect(sentTexts.slice(-4, -1)).toEqual(paragraphs.slice(-3));
      expect(sentTexts.at(-1)).toBe("Codex 已完成。");
      expect(logger.info).toHaveBeenCalledWith(
        "continuation delivery completed",
        expect.objectContaining({
          userId: "user@im.wechat",
          sourceMessageId: "continue-1",
          deliveredChunkCount: 3
        })
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not hijack 1 for continuation while Codex is awaiting approval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const sentTexts: string[] = [];
      const router = {
        handleInput: vi.fn(async () => "approval ok"),
        codexStatus: vi.fn(async () => ({ state: "awaiting_approval" }))
      };
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          const body = JSON.parse(String(init?.body));
          sentTexts.push(body.msg.item_list[0].text_item.text);
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
        router: router as never,
        logger: fakeLogger(),
        reliableSendIntervalMs: 0
      });
      (runner as unknown as {
        pendingContinuations: Map<string, { sourceMessageId: string; pendingChunks: string[]; createdAt: number; updatedAt: number }>;
      }).pendingContinuations.set("user@im.wechat", {
        sourceMessageId: "older",
        pendingChunks: ["剩余内容"],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "approval-1", userId: "user@im.wechat", content: "1", contextToken: "ctx-a" });

      expect(router.handleInput).toHaveBeenCalledTimes(1);
      expect(sentTexts).toContain("approval ok");
      expect(sentTexts).not.toContain("剩余内容");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports when a continuation state has expired instead of sending 1 into the router", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const sentTexts: string[] = [];
      const router = {
        handleInput: vi.fn(async () => "should not happen")
      };
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          const body = JSON.parse(String(init?.body));
          sentTexts.push(body.msg.item_list[0].text_item.text);
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
        router: router as never,
        logger: fakeLogger(),
        reliableSendIntervalMs: 0
      });
      (runner as unknown as {
        pendingContinuations: Map<string, { sourceMessageId: string; pendingChunks: string[]; createdAt: number; updatedAt: number }>;
      }).pendingContinuations.set("user@im.wechat", {
        sourceMessageId: "expired",
        pendingChunks: ["剩余内容"],
        createdAt: Date.now() - 121 * 60_000,
        updatedAt: Date.now() - 121 * 60_000
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "expired-1", userId: "user@im.wechat", content: "1", contextToken: "ctx-a" });

      expect(router.handleInput).not.toHaveBeenCalled();
      expect(sentTexts).toContain("上一轮续写状态已失效，请重新提问。");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("streams up to the continuation prompt within a 10-send WeChat context budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const deliveredTexts: string[] = [];
      let successfulSends = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          if (successfulSends >= 10) {
            return new Response(JSON.stringify({ ret: -2, errcode: 0, errmsg: "context budget exceeded" }));
          }
          const body = JSON.parse(String(init?.body));
          deliveredTexts.push(body.msg.item_list[0].text_item.text);
          successfulSends += 1;
          return new Response(JSON.stringify({ ret: 0 }));
        }
        throw new Error(`unexpected url: ${url} ${String(init?.method ?? "GET")}`);
      }));

      const segments = Array.from({ length: 12 }, (_, index) => `第${index + 1}段${"说明".repeat(320)}。`);
      const reply = segments.join("\n\n");
      const store = new BridgeStore(dir);
      await store.writeJson("welcome-state.json", { version: 2, sentTo: { "user@im.wechat": 2 } });
      const runner = new WechatBridgeRunner({
        config: { ...defaultConfig("/work"), ownerUserId: "user@im.wechat", longPollTimeoutMs: 10 },
        account: { token: "token" },
        store,
        router: {
          handleInput: vi.fn(async (_input, hooks?: { onDelta?: (delta: string) => void }) => {
            for (const segment of segments) {
              hooks?.onDelta?.(segment);
            }
            return reply;
          })
        } as never,
        logger: fakeLogger(),
        progressSendIntervalMs: 0,
        reliableSendIntervalMs: 0
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "budget-10", userId: "user@im.wechat", content: "给我完整说明", contextToken: "ctx" });

      expect(successfulSends).toBe(10);
      expect(deliveredTexts.join("")).toContain("第8段");
      expect(deliveredTexts.join("")).not.toContain("第12段");
      expect(deliveredTexts.at(-1)).toBe("回复 1 继续");
      expect(deliveredTexts.join("\n")).not.toContain("流式回传不完整");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not truncate a normal five-part stream just to reserve fallback slots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const sentTexts: string[] = [];
      const logger = fakeLogger();
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          const body = JSON.parse(String(init?.body));
          sentTexts.push(body.msg.item_list[0].text_item.text);
          return new Response(JSON.stringify({ ret: 0 }));
        }
        throw new Error(`unexpected url: ${url} ${String(init?.method ?? "GET")}`);
      }));

      const segments = Array.from({ length: 5 }, (_, index) => `第${index + 1}段说明。`);
      const store = new BridgeStore(dir);
      await store.writeJson("welcome-state.json", { version: 2, sentTo: { "user@im.wechat": 2 } });
      const runner = new WechatBridgeRunner({
        config: { ...defaultConfig("/work"), ownerUserId: "user@im.wechat", longPollTimeoutMs: 10 },
        account: { token: "token" },
        store,
        router: {
          handleInput: vi.fn(async (_input, hooks?: { onDelta?: (delta: string) => void }) => {
            for (const segment of segments) {
              hooks?.onDelta?.(segment);
            }
            return segments.join("");
          })
        } as never,
        logger,
        progressSendIntervalMs: 0,
        reliableSendIntervalMs: 0
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "budget-normal", userId: "user@im.wechat", content: "给我五段说明", contextToken: "ctx" });

      expect(sentTexts).toContain("第5段说明。");
      expect(sentTexts).toContain("Codex 已完成。");
      expect(sentTexts.join("\n")).not.toContain("流式回传不完整");
      expect(logger.warn).not.toHaveBeenCalledWith(
        "wechat send budget reached",
        expect.anything()
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a task-level overload error instead of pretending the turn completed without text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const sentTexts: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          const body = JSON.parse(String(init?.body));
          sentTexts.push(body.msg.item_list[0].text_item.text);
          return new Response(JSON.stringify({ ret: 0 }));
        }
        throw new Error(`unexpected url: ${url} ${String(init?.method ?? "GET")}`);
      }));

      const router = {
        handleInput: vi.fn(async () => {
          throw new Error("Selected model is at capacity. Please try a different model. (server_overloaded)");
        })
      };
      const store = new BridgeStore(dir);
      await store.writeJson("welcome-state.json", { version: 2, sentTo: { "user@im.wechat": 2 } });
      const runner = new WechatBridgeRunner({
        config: { ...defaultConfig("/work"), ownerUserId: "user@im.wechat", longPollTimeoutMs: 10 },
        account: { token: "token" },
        store,
        router: router as never,
        logger: fakeLogger(),
        reliableSendIntervalMs: 0
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "overload-1", userId: "user@im.wechat", content: "具体怎么脏？能怎么清理？", contextToken: "ctx-a" });

      expect(sentTexts.join("\n")).toContain("Bridge error: Selected model is at capacity.");
      expect(sentTexts.join("\n")).toContain("Please try a different model.");
      expect(sentTexts.join("\n")).toContain("(server_overloaded)");
      expect(sentTexts).not.toContain(CODEX_NO_TEXT_OUTPUT_MESSAGE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("proactively chunks the complete fallback reply even when WeChat accepts each send", async () => {
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

      const reply = "第一段第一句。第一段第二句。\n\n第二段第一句。";
      const store = new BridgeStore(dir);
      await store.writeJson("welcome-state.json", { version: 2, sentTo: { "user@im.wechat": 2 } });
      const runner = new WechatBridgeRunner({
        config: { ...defaultConfig("/work"), ownerUserId: "user@im.wechat", longPollTimeoutMs: 10 },
        account: { token: "token" },
        store,
        router: {
          handleInput: vi.fn(async (_input, hooks?: { onDelta?: (delta: string) => void }) => {
            hooks?.onDelta?.("ABCDEFGHIJKLMN");
            return reply;
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
        maxMessageLength: 14,
        minSendIntervalMs: 0,
        retryDelaysMs: [],
        sleep: async () => {}
      }));

      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "11b", userId: "user@im.wechat", content: "stream please", contextToken: "ctx" });

      const fallbackTexts = sentTexts.filter((text) => text.includes("流式回传不完整") || text.includes("第一段") || text.includes("第二段"));
      expect(fallbackTexts).toHaveLength(3);
      expect(fallbackTexts).toEqual([
        "流式回传不完整，下面是完整回复：",
        "第一段第一句。第一段第二句。",
        "第二段第一句。"
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reliably splits a long final reply even when there was no streamed delta", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const sentTexts: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          const body = JSON.parse(String(init?.body));
          const text = body.msg.item_list[0].text_item.text;
          if (text.length > 8) {
            return new Response(JSON.stringify({ ret: -3, errcode: 0, errmsg: "payload too large" }));
          }
          sentTexts.push(text);
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
          handleInput: vi.fn(async () => "ABCDEFGHIJKLMN")
        } as never,
        logger: fakeLogger()
      });
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "12", userId: "user@im.wechat", content: "/long", contextToken: "ctx" });

      expect(sentTexts.join("")).toBe("ABCDEFGHIJKLMN");
      expect(sentTexts.every((text) => text.length <= 8)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("proactively chunks a long final reply without waiting for WeChat to reject it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      const sentTexts: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          const body = JSON.parse(String(init?.body));
          sentTexts.push(body.msg.item_list[0].text_item.text);
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
          handleInput: vi.fn(async () => "第一段第一句。第一段第二句。\n\n第二段第一句。")
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
        maxMessageLength: 14,
        minSendIntervalMs: 0,
        retryDelaysMs: [],
        sleep: async () => {}
      }));
      const handleMessage = (runner as unknown as {
        handleMessage(message: { id: string; userId: string; content: string; contextToken: string }): Promise<void>;
      }).handleMessage.bind(runner);

      await handleMessage({ id: "12b", userId: "user@im.wechat", content: "/long", contextToken: "ctx" });

      expect(sentTexts).toEqual([
        "第一段第一句。第一段第二句。",
        "第二段第一句。"
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sends at most one idle keepalive per hour while a long task stays quiet", async () => {
    vi.useFakeTimers();
    const runner = new WechatBridgeRunner({
      config: { ...defaultConfig("/work"), ownerUserId: "user@im.wechat", longPollTimeoutMs: 10 },
      account: { token: "token" },
      store: {} as never,
      router: {} as never,
      logger: fakeLogger()
    });
    const sentTexts: string[] = [];
    const keepalive = (runner as unknown as {
      createLongTaskKeepalive(progress: { sendNotice(text: string): Promise<void> }): {
        markActivity(): void;
        stop(): void;
      };
    }).createLongTaskKeepalive({
      sendNotice: vi.fn(async (text: string) => {
        sentTexts.push(text);
      })
    });

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    expect(sentTexts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(sentTexts.filter((text) => text.includes("仍在处理中"))).toHaveLength(1);

    keepalive.markActivity();
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    expect(sentTexts.filter((text) => text.includes("仍在处理中"))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(sentTexts.filter((text) => text.includes("仍在处理中"))).toHaveLength(2);

    keepalive.stop();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(sentTexts.filter((text) => text.includes("仍在处理中"))).toHaveLength(2);
  });

  it("does not advance the sync cursor until received messages are enqueued", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-runner-"));
    try {
      let releaseSend: (() => void) | null = null;
      const sendStarted = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/getupdates") {
          return new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: "cursor-after-message",
            msgs: [{
              message_id: "cursor-1",
              message_type: 1,
              from_user_id: "user@im.wechat",
              context_token: "ctx",
              item_list: [{ type: 1, text_item: { text: "/status" } }]
            }]
          }));
        }
        if (url === "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage") {
          await sendStarted;
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
          handleInput: vi.fn(async () => "status ok")
        } as never,
        logger: fakeLogger()
      });

      await runner.pollOnce();
      await expect(store.readJson("sync_cursor.json", null)).resolves.toBeNull();

      releaseSend?.();
      await vi.waitFor(async () => {
        await expect(store.readJson("sync_cursor.json")).resolves.toEqual({ cursor: "cursor-after-message" });
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

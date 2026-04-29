import { describe, expect, it, vi } from "vitest";
import { ProgressSender } from "../src/wechat/progress-sender.js";

describe("ProgressSender", () => {
  it("sends complete paragraphs as separate WeChat messages", async () => {
    const sent: string[] = [];
    const sender = new ProgressSender({
      send: async (text) => {
        sent.push(text);
      },
      logger: fakeLogger(),
      minSendIntervalMs: 0
    });

    sender.push("第一段第一句。第一段第二句。\n\n第二段");
    await sender.flushAll();

    expect(sent).toEqual(["第一段第一句。第一段第二句。", "第二段"]);
  });

  it("sends complete sentences without waiting for a large fixed chunk", async () => {
    const sent: string[] = [];
    const sender = new ProgressSender({
      send: async (text) => {
        sent.push(text);
      },
      logger: fakeLogger(),
      minSendIntervalMs: 0
    });

    sender.push("我先做第一步。");
    await sender.settle();
    sender.push("然后做第二步");
    await sender.settle();
    sender.push("。");
    await sender.flushAll();

    expect(sent).toEqual(["我先做第一步。", "然后做第二步。"]);
  });

  it("keeps fenced code blocks together until the closing fence arrives", async () => {
    const sent: string[] = [];
    const sender = new ProgressSender({
      send: async (text) => {
        sent.push(text);
      },
      logger: fakeLogger(),
      minSendIntervalMs: 0
    });

    sender.push("运行：\n```bash\nnpm ");
    await sender.settle();
    expect(sent).toEqual([]);

    sender.push("run build\n```\n完成。");
    await sender.flushAll();

    expect(sent).toEqual(["运行：\n```bash\nnpm run build\n```", "完成。"]);
  });

  it("retries transient send failures before giving up on a chunk", async () => {
    const sent: string[] = [];
    let attempts = 0;
    const sender = new ProgressSender({
      send: async (text) => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("fetch failed");
        }
        sent.push(text);
      },
      logger: fakeLogger(),
      minSendIntervalMs: 0,
      retryDelaysMs: [0, 0],
      sleep: async () => {}
    });

    sender.push("重试一次就好");
    await sender.flushAll();

    expect(sent).toEqual(["重试一次就好"]);
    expect(attempts).toBe(3);
  });

  it("splits and resends a chunk when iLink rejects it with ret=-2", async () => {
    const sent: string[] = [];
    const sender = new ProgressSender({
      send: async (text) => {
        if (text.length > 8) {
          throw new Error("iLink sendmessage failed: ret=-2 errcode=0 errmsg=");
        }
        sent.push(text);
      },
      logger: fakeLogger(),
      minSendIntervalMs: 0,
      retryDelaysMs: [],
      sleep: async () => {}
    });

    sender.push("ABCDEFGHIJKLMN");
    await sender.flushAll();

    expect(sent.join("")).toBe("ABCDEFGHIJKLMN");
    expect(sent.every((part) => part.length <= 8)).toBe(true);
  });

  it("waits between sends to avoid hammering WeChat too quickly", async () => {
    const sent: string[] = [];
    const sleeps: number[] = [];
    let now = 0;
    const sender = new ProgressSender({
      send: async (text) => {
        sent.push(text);
      },
      logger: fakeLogger(),
      minSendIntervalMs: 500,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      }
    });

    sender.push("第一段。\n\n第二段");
    await sender.flushAll();

    expect(sent).toEqual(["第一段。", "第二段"]);
    expect(sleeps).toEqual([500]);
  });
});

function fakeLogger() {
  return {
    warn: vi.fn(async () => {})
  };
}

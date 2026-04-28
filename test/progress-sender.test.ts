import { describe, expect, it, vi } from "vitest";
import { ProgressSender } from "../src/wechat/progress-sender.js";

describe("ProgressSender", () => {
  it("sends complete paragraphs as separate WeChat messages", async () => {
    const sent: string[] = [];
    const sender = new ProgressSender({
      send: async (text) => {
        sent.push(text);
      },
      logger: fakeLogger()
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
      logger: fakeLogger()
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
      logger: fakeLogger()
    });

    sender.push("运行：\n```bash\nnpm ");
    await sender.settle();
    expect(sent).toEqual([]);

    sender.push("run build\n```\n完成。");
    await sender.flushAll();

    expect(sent).toEqual(["运行：\n```bash\nnpm run build\n```", "完成。"]);
  });
});

function fakeLogger() {
  return {
    warn: vi.fn(async () => {})
  };
}

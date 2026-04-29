import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTurnInput,
  buildThreadResumeParams,
  buildThreadStartParams,
  detectGeneratedFileOutputs,
  extractImageOutput,
  extractImageOutputText,
  formatApprovalRequest
} from "../src/codex/app-server-client.js";

describe("CodexAppServerClient helpers", () => {
  it("starts and resumes threads with full filesystem access by default", () => {
    expect(buildThreadStartParams("/work/project")).toMatchObject({
      cwd: "/work/project",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "danger-full-access"
    });

    expect(buildThreadResumeParams("/work/project", "thread-old")).toMatchObject({
      threadId: "thread-old",
      cwd: "/work/project",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "danger-full-access"
    });
  });

  it("formats actionable approval details for WeChat", () => {
    const request = formatApprovalRequest("item/commandExecution/requestApproval", {
      command: "mv ~/Downloads/a ~/Downloads/b",
      cwd: "/Users/me/Downloads",
      reason: "needs Downloads write access",
      additionalPermissions: {
        fileSystem: {
          writable_roots: ["/Users/me/Downloads"]
        }
      }
    });

    expect(request.summary).toContain("Codex 请求执行命令");
    expect(request.summary).toContain("命令: mv ~/Downloads/a ~/Downloads/b");
    expect(request.summary).toContain("目录: /Users/me/Downloads");
    expect(request.summary).toContain("原因: needs Downloads write access");
    expect(request.summary).toContain("权限");
    expect(request.summary).toContain("/Users/me/Downloads");
    expect(request.summary).toContain("回复 1 同意，2 拒绝");
  });

  it("serializes local image attachments for turn/start", () => {
    expect(buildTurnInput("看这张图", [{ path: "/tmp/chart.png" }])).toEqual([
      { type: "text", text: "看这张图", text_elements: [] },
      { type: "localImage", path: "/tmp/chart.png" }
    ]);
  });

  it("embeds local file paths into the text input for turn/start", () => {
    expect(buildTurnInput(
      "请总结",
      [],
      [{ path: "/tmp/spec.pdf", originalName: "产品方案.pdf" }]
    )).toEqual([
      {
        type: "text",
        text: [
          "请总结",
          "",
          "附带文件（请直接读取本地路径）:",
          "1. /tmp/spec.pdf | 原始文件名: 产品方案.pdf"
        ].join("\n"),
        text_elements: []
      }
    ]);
  });

  it("renders image generation outputs as WeChat-friendly text", () => {
    const params = {
      item: {
        type: "imageGeneration",
        status: "completed",
        result: "https://example.com/image.png",
        savedPath: "/tmp/image.png"
      }
    };

    expect(extractImageOutput(params)).toEqual({
      url: "https://example.com/image.png",
      path: "/tmp/image.png",
      fallbackText: "图片 URL: https://example.com/image.png\n图片已保存: /tmp/image.png"
    });
    expect(extractImageOutputText(params)).toBe("图片 URL: https://example.com/image.png\n图片已保存: /tmp/image.png");
  });

  it("detects newly generated workspace artifacts and ignores source edits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-output-"));
    try {
      await writeFile(join(dir, "existing.md"), "already here");
      const before = await detectGeneratedFileOutputs.snapshot(dir);

      await writeFile(join(dir, "report.pdf"), "pdf output");
      await writeFile(join(dir, "notes.md"), "markdown output");
      await writeFile(join(dir, "src.ts"), "source edit");

      const outputs = await detectGeneratedFileOutputs.collect(dir, before);

      expect(outputs.map((output) => output.path.replace(`${dir}/`, "")).sort()).toEqual([
        "notes.md",
        "report.pdf"
      ]);
      expect(outputs.every((output) => output.fallbackText.includes("文件已生成"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionRouter } from "../src/session-router.js";
import { BridgeStore } from "../src/storage.js";

describe("SessionRouter", () => {
  it("rejects ordinary messages while codex is busy", async () => {
    const codex = {
      status: vi.fn(() => ({ state: "busy", activeThreadId: "thread-1" })),
      startThread: vi.fn(),
      sendTurn: vi.fn(),
      listThreads: vi.fn(),
      resumeThread: vi.fn(),
      stop: vi.fn()
    };
    const router = new SessionRouter(codex);

    await expect(router.handleText("hello")).resolves.toContain("busy");
    expect(codex.sendTurn).not.toHaveBeenCalled();
  });

  it("creates a thread for /new and sends ordinary text to the active thread", async () => {
    const codex = {
      status: vi.fn(() => ({ state: "idle", activeThreadId: "thread-1" })),
      startThread: vi.fn(async () => ({ threadId: "thread-1" })),
      sendTurn: vi.fn(async () => "done"),
      listThreads: vi.fn(),
      resumeThread: vi.fn(),
      stop: vi.fn()
    };
    const router = new SessionRouter(codex);

    await expect(router.handleText("/new")).resolves.toContain("thread-1");
    await expect(router.handleText("ship it")).resolves.toBe("done");
    expect(codex.sendTurn).toHaveBeenCalledWith("thread-1", "ship it");
  });

  it("calls turn start and delta hooks for ordinary text", async () => {
    const onTurnStart = vi.fn();
    const onDelta = vi.fn();
    const codex = {
      status: vi.fn(() => ({ state: "idle", activeThreadId: "thread-1" })),
      startThread: vi.fn(),
      sendTurn: vi.fn(async (_threadId: string, _text: string, options?: { onDelta?: (delta: string) => void }) => {
        options?.onDelta?.("partial");
        return "partial";
      }),
      listThreads: vi.fn(),
      resumeThread: vi.fn(),
      stop: vi.fn()
    };
    const router = new SessionRouter(codex);

    await expect(router.handleText("stream it", { onTurnStart, onDelta })).resolves.toBe("partial");
    expect(onTurnStart).toHaveBeenCalledTimes(1);
    expect(onDelta).toHaveBeenCalledWith("partial");
    expect(codex.sendTurn).toHaveBeenCalledWith("thread-1", "stream it", { onDelta });
  });

  it("sends image-only messages to Codex with a default prompt", async () => {
    const codex = {
      status: vi.fn(() => ({ state: "idle", activeThreadId: "thread-1" })),
      startThread: vi.fn(),
      sendTurn: vi.fn(async () => "done"),
      listThreads: vi.fn(),
      resumeThread: vi.fn(),
      stop: vi.fn()
    };
    const router = new SessionRouter(codex);

    await expect(router.handleInput({
      text: "",
      images: [{ path: "/tmp/wechat-image.png" }]
    })).resolves.toBe("done");
    expect(codex.sendTurn).toHaveBeenCalledWith(
      "thread-1",
      "请分析这张图片。",
      undefined,
      [{ path: "/tmp/wechat-image.png" }]
    );
  });

  it("persists the active thread and resumes by thread list index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-router-"));
    try {
      const store = new BridgeStore(dir);
      const codex = {
        status: vi.fn(() => ({ state: "idle" })),
        startThread: vi.fn(),
        sendTurn: vi.fn(async () => "done"),
        listThreads: vi.fn(async () => [
          { id: "thread-a", name: "Alpha", preview: "A", updatedAt: 1777360000 },
          { id: "thread-b", name: "Beta", preview: "B", updatedAt: 1777361000 }
        ]),
        resumeThread: vi.fn(async (threadId: string) => ({ threadId })),
        stop: vi.fn()
      };
      const router = new SessionRouter(codex, store);

      await expect(router.handleText("/resume 2")).resolves.toContain("thread-b");
      await expect(store.readJson("bridge-state.json")).resolves.toMatchObject({
        activeThreadByProject: {
          "codex-wechat-bridge": "thread-b"
        }
      });

      await expect(router.handleText("next")).resolves.toBe("done");
      expect(codex.resumeThread).toHaveBeenLastCalledWith("thread-b");
      expect(codex.sendTurn).toHaveBeenCalledWith("thread-b", "next");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists threads by index and display name", async () => {
    const codex = {
      status: vi.fn(() => ({ state: "idle", activeThreadId: "thread-b" })),
      startThread: vi.fn(),
      sendTurn: vi.fn(),
      listThreads: vi.fn(async () => [
        { id: "thread-a", name: "下载归档", preview: "整理下载目录", updatedAt: 1777360000 },
        { id: "thread-b", name: "微信桥", preview: "优化微信桥", updatedAt: 1777361000 }
      ]),
      resumeThread: vi.fn(),
      stop: vi.fn()
    };
    const router = new SessionRouter(codex);

    const output = await router.handleText("/threads");

    expect(output).toContain("Current: thread-b");
    expect(output).toContain("1. 下载归档");
    expect(output).toContain("2. 微信桥 *");

    const singularOutput = await router.handleText("/thread");
    expect(singularOutput).toContain("1. 下载归档");

    const chineseOutput = await router.handleText("/thread列表");
    expect(chineseOutput).toContain("2. 微信桥 *");

    const bareChineseOutput = await router.handleText("线程列表");
    expect(bareChineseOutput).toContain("1. 下载归档");
    expect(codex.sendTurn).not.toHaveBeenCalled();
  });

  it("resumes threads with Chinese aliases", async () => {
    const codex = {
      status: vi.fn(() => ({ state: "idle" })),
      startThread: vi.fn(),
      sendTurn: vi.fn(),
      listThreads: vi.fn(async () => [
        { id: "thread-a", name: "Alpha", preview: "A", updatedAt: 1777360000 },
        { id: "thread-b", name: "Beta", preview: "B", updatedAt: 1777361000 }
      ]),
      resumeThread: vi.fn(async (threadId: string) => ({ threadId })),
      stop: vi.fn()
    };
    const router = new SessionRouter(codex);

    await expect(router.handleText("线程 2")).resolves.toContain("thread-b");
    await expect(router.handleText("/切线程 thread-a")).resolves.toContain("thread-a");
    expect(codex.sendTurn).not.toHaveBeenCalled();
  });

  it("lists configured projects with the current project marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-router-"));
    try {
      const store = new BridgeStore(dir);
      await store.writeJson("projects.json", {
        projects: [
          { key: "bridge", path: "/work/bridge" },
          { key: "misc", path: "/work/misc" }
        ]
      });
      await store.writeJson("bridge-state.json", { activeProjectKey: "misc", activeThreadByProject: {} });
      const codex = fakeCodex("idle");
      const router = new SessionRouter(codex, store, { workspace: "/work/bridge" });

      const output = await router.handleText("/projects");

      expect(output).toContain("1. bridge");
      expect(output).toContain("2. misc *");
      expect(output).toContain("/work/misc");

      const singularOutput = await router.handleText("/project");
      expect(singularOutput).toContain("1. bridge");
      expect(singularOutput).toContain("2. misc *");

      const chineseOutput = await router.handleText("项目列表");
      expect(chineseOutput).toContain("1. bridge");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("switches project by index and restores each project's active thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-router-"));
    try {
      const store = new BridgeStore(dir);
      await store.writeJson("projects.json", {
        projects: [
          { key: "bridge", path: "/work/bridge" },
          { key: "misc", path: "/work/misc" }
        ]
      });
      await store.writeJson("bridge-state.json", {
        activeProjectKey: "bridge",
        activeThreadByProject: {
          bridge: "thread-bridge",
          misc: "thread-misc"
        }
      });
      const byProject = new Map([
        ["bridge", fakeCodex("idle")],
        ["misc", {
          ...fakeCodex("idle"),
          resumeThread: vi.fn(async (threadId: string) => ({ threadId })),
          sendTurn: vi.fn(async () => "done")
        }]
      ]);
      const router = new SessionRouter(byProject.get("bridge")!, store, {
        workspace: "/work/bridge",
        codexFactory: (project) => byProject.get(project.key)!
      });

      await expect(router.handleText("/project 2")).resolves.toContain("misc");
      await expect(router.handleText("项目 bridge")).resolves.toContain("bridge");
      await expect(router.handleText("项目 2")).resolves.toContain("misc");
      await expect(router.handleText("hello")).resolves.toBe("done");
      expect(byProject.get("misc")!.resumeThread).toHaveBeenCalledWith("thread-misc");
      expect(byProject.get("misc")!.sendTurn).toHaveBeenCalledWith("thread-misc", "hello");
      await expect(store.readJson("bridge-state.json")).resolves.toMatchObject({
        activeProjectKey: "misc",
        activeThreadByProject: {
          bridge: "thread-bridge",
          misc: "thread-misc"
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("starts and stops with Chinese aliases", async () => {
    const codex = {
      ...fakeCodex("idle"),
      startThread: vi.fn(async () => ({ threadId: "thread-new" })),
      stop: vi.fn(async () => "Stop requested.")
    };
    const router = new SessionRouter(codex);

    await expect(router.handleText("新线程")).resolves.toContain("thread-new");
    await expect(router.handleText("停下")).resolves.toBe("Stop requested.");
    await expect(router.handleText("/停止")).resolves.toBe("Stop requested.");
    expect(codex.sendTurn).not.toHaveBeenCalled();
  });

  it("refuses project switching while codex is busy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-router-"));
    try {
      const store = new BridgeStore(dir);
      await store.writeJson("projects.json", {
        projects: [
          { key: "bridge", path: "/work/bridge" },
          { key: "misc", path: "/work/misc" }
        ]
      });
      const codex = fakeCodex("busy", "thread-1");
      const router = new SessionRouter(codex, store, { workspace: "/work/bridge" });

      await expect(router.handleText("/project 2")).resolves.toContain("busy");
      await expect(store.readJson("bridge-state.json", {})).resolves.not.toMatchObject({ activeProjectKey: "misc" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("approves and denies pending Codex approvals", async () => {
    const codex = {
      ...fakeCodex("awaiting_approval", "thread-1"),
      approvePending: vi.fn(async () => "Approved pending Codex request."),
      denyPending: vi.fn(async () => "Denied pending Codex request.")
    };
    const router = new SessionRouter(codex);

    await expect(router.handleText("/approve")).resolves.toContain("Approved");
    await expect(router.handleText("/deny")).resolves.toContain("Denied");
    expect(codex.approvePending).toHaveBeenCalledTimes(1);
    expect(codex.denyPending).toHaveBeenCalledTimes(1);
  });

  it("treats 1 and 2 as approval shortcuts only while awaiting approval", async () => {
    const approvingCodex = {
      ...fakeCodex("awaiting_approval", "thread-1"),
      approvePending: vi.fn(async () => "Approved pending Codex request."),
      denyPending: vi.fn(async () => "Denied pending Codex request.")
    };
    const approvingRouter = new SessionRouter(approvingCodex);

    await expect(approvingRouter.handleText("1")).resolves.toContain("Approved");
    await expect(approvingRouter.handleText("2")).resolves.toContain("Denied");
    expect(approvingCodex.approvePending).toHaveBeenCalledTimes(1);
    expect(approvingCodex.denyPending).toHaveBeenCalledTimes(1);

    const idleCodex = {
      ...fakeCodex("idle", "thread-1"),
      sendTurn: vi.fn(async () => "sent")
    };
    const idleRouter = new SessionRouter(idleCodex);
    await expect(idleRouter.handleText("1")).resolves.toBe("sent");
    expect(idleCodex.approvePending).not.toHaveBeenCalled();
    expect(idleCodex.sendTurn).toHaveBeenCalledWith("thread-1", "1");
  });
});

function fakeCodex(state: "idle" | "busy" | "awaiting_approval" | "disconnected", activeThreadId?: string) {
  return {
    status: vi.fn(() => ({ state, activeThreadId })),
    startThread: vi.fn(),
    sendTurn: vi.fn(),
    listThreads: vi.fn(async () => []),
    resumeThread: vi.fn(),
    stop: vi.fn(),
    approvePending: vi.fn(),
    denyPending: vi.fn()
  };
}

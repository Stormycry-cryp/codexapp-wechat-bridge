import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refreshProjectThreadIndex } from "../src/refresh.js";
import { BridgeStore } from "../src/storage.js";

describe("refreshProjectThreadIndex", () => {
  it("persists projects from Codex threads and maps each project to the latest unarchived thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-refresh-"));
    try {
      const store = new BridgeStore(join(dir, "bridge-data"));
      const workspace = join(dir, "CodexBridge");
      const manual = join(dir, "manual-project");
      const app = join(dir, "app");
      const desktopOnly = join(dir, "desktop-only");
      const archivedOnly = join(dir, "archived-only");
      await mkdir(workspace, { recursive: true });
      await mkdir(manual, { recursive: true });
      await mkdir(app, { recursive: true });
      await mkdir(desktopOnly, { recursive: true });
      await mkdir(archivedOnly, { recursive: true });
      await store.writeJson("projects.json", {
        projects: [{ key: "manual", path: manual }]
      });
      await store.writeJson("bridge-state.json", {
        activeProjectKey: "manual",
        activeThreadByProject: { manual: "manual-thread" }
      });
      const globalStatePath = join(dir, "codex-global-state.json");
      await writeFile(globalStatePath, JSON.stringify({
        "electron-saved-workspace-roots": [desktopOnly]
      }));

      const result = await refreshProjectThreadIndex({
        store,
        workspace,
        globalStatePath,
        threadRows: [
          { id: "old-app-thread", title: "old", cwd: app, updatedAtMs: 1000, archived: false },
          { id: "new-app-thread", title: "new", cwd: app, updatedAtMs: 2000, archived: false },
          { id: "archived-thread", title: "done", cwd: archivedOnly, updatedAtMs: 3000, archived: true }
        ],
        backup: false
      });

      expect(result).toMatchObject({
        projectCount: 5,
        activeProjectKey: "manual",
        mappedThreadCount: 2
      });
      await expect(store.readJson("projects.json")).resolves.toEqual({
        projects: [
          { key: "CodexBridge", path: workspace },
          { key: "manual", path: manual },
          { key: "app", path: app },
          { key: "archived-only", path: archivedOnly },
          { key: "desktop-only", path: desktopOnly }
        ]
      });
      await expect(store.readJson("bridge-state.json")).resolves.toMatchObject({
        activeProjectKey: "manual",
        activeThreadByProject: {
          manual: "manual-thread",
          app: "new-app-thread"
        },
        recentListContext: {
          kind: "project",
          entries: ["CodexBridge", "manual", "app", "archived-only", "desktop-only"]
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

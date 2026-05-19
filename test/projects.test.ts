import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectRegistry } from "../src/projects.js";
import { BridgeStore } from "../src/storage.js";

describe("ProjectRegistry", () => {
  it("merges manual projects with Codex session workspaces and deduplicates by path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-projects-"));
    try {
      const store = new BridgeStore(dir);
      const sessionsDir = join(dir, "sessions");
      const manualPath = join(dir, "manual-project");
      const historyPath = join(dir, "history-project");
      await mkdir(manualPath, { recursive: true });
      await mkdir(historyPath, { recursive: true });
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(historyPath, "package.json"), "{}\n");
      await store.writeJson("projects.json", {
        projects: [{ key: "manual", path: manualPath }]
      });
      await writeFile(join(sessionsDir, "one.jsonl"), [
        JSON.stringify({ type: "session_meta", payload: { cwd: manualPath } }),
        JSON.stringify({ type: "turn_context", payload: { cwd: historyPath } })
      ].join("\n"));

      const registry = new ProjectRegistry(store, manualPath, {
        codexHistory: true,
        codexSessionsDir: sessionsDir,
        codexDesktopGlobalStatePath: join(dir, "missing-codex-global-state.json")
      });

      await expect(registry.list()).resolves.toEqual([
        { key: "manual", path: manualPath },
        { key: "history-project", path: historyPath }
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discovers projects from configured roots and assigns unique keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-projects-"));
    try {
      const store = new BridgeStore(dir);
      const workspace = join(dir, "workspace");
      const rootsDir = join(dir, "roots");
      const alpha = join(rootsDir, "Alpha App");
      const alphaNested = join(rootsDir, "group", "Alpha App");
      const beta = join(rootsDir, "Beta");
      await mkdir(workspace, { recursive: true });
      await mkdir(alpha, { recursive: true });
      await mkdir(alphaNested, { recursive: true });
      await mkdir(beta, { recursive: true });
      await writeFile(join(alpha, "package.json"), "{}\n");
      await writeFile(join(alphaNested, "pyproject.toml"), "[project]\nname='alpha-nested'\n");
      await writeFile(join(beta, "Cargo.toml"), "[package]\nname='beta'\n");

      const registry = new ProjectRegistry(store, workspace, {
        discoveryRoots: [rootsDir],
        discoveryMaxDepth: 3,
        codexDesktopGlobalStatePath: join(dir, "missing-codex-global-state.json")
      });

      const projects = await registry.list();
      expect(projects).toEqual([
        { key: "workspace", path: workspace },
        { key: "Alpha-App", path: alpha },
        { key: "Alpha-App-2", path: alphaNested },
        { key: "Beta", path: beta }
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discovers projects from Codex desktop global state workspace roots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cwb-projects-"));
    try {
      const store = new BridgeStore(dir);
      const workspace = join(dir, "workspace");
      const desktopProject = join(dir, "desktop-project");
      const globalStatePath = join(dir, "codex-global-state.json");
      await mkdir(workspace, { recursive: true });
      await mkdir(desktopProject, { recursive: true });
      await writeFile(join(desktopProject, "package.json"), "{}\n");
      await writeFile(globalStatePath, JSON.stringify({
        "active-workspace-roots": [desktopProject],
        "electron-saved-workspace-roots": [desktopProject],
        "project-order": [desktopProject]
      }, null, 2));

      const registry = new ProjectRegistry(store, workspace, {
        codexDesktopGlobalStatePath: globalStatePath
      });

      await expect(registry.list()).resolves.toEqual([
        { key: "workspace", path: workspace },
        { key: "desktop-project", path: desktopProject }
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

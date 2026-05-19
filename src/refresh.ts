import { execFile } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { BridgeProject } from "./projects.js";
import type { BridgeStore } from "./storage.js";

const execFileAsync = promisify(execFile);

export type CodexThreadIndexRow = {
  id: string;
  title?: string;
  cwd: string;
  updatedAtMs: number;
  archived: boolean;
};

export type RefreshProjectThreadIndexOptions = {
  store: BridgeStore;
  workspace: string;
  stateDbPath?: string;
  globalStatePath?: string;
  threadRows?: CodexThreadIndexRow[];
  backup?: boolean;
};

export type RefreshProjectThreadIndexResult = {
  projectCount: number;
  mappedThreadCount: number;
  activeProjectKey: string;
  backupStamp?: string;
};

type BridgeStateFile = {
  activeProjectKey?: string;
  activeThreadByProject?: Record<string, string>;
  recentListContext?: {
    kind: "project" | "thread";
    entries: string[];
  };
};

type ProjectsFile = {
  projects?: BridgeProject[];
};

export async function refreshProjectThreadIndex(options: RefreshProjectThreadIndexOptions): Promise<RefreshProjectThreadIndexResult> {
  const workspace = resolve(options.workspace);
  const threadRows = options.threadRows ?? await readThreadRows(options.stateDbPath ?? defaultStateDbPath());
  const desktopRoots = await readDesktopWorkspaceRoots(options.globalStatePath ?? defaultGlobalStatePath());
  const existingProjects = (await options.store.readJson<ProjectsFile>("projects.json", {})).projects ?? [];
  const existingState = await options.store.readJson<BridgeStateFile>("bridge-state.json", {});

  const projects = buildProjects([
    workspace,
    ...existingProjects.map((project) => project.path),
    ...threadRows.map((row) => row.cwd),
    ...desktopRoots
  ], existingProjects);
  const keyByPath = new Map(projects.map((project) => [project.path, project.key]));
  const activeThreadByProject = {
    ...(existingState.activeThreadByProject ?? {})
  };

  for (const row of [...threadRows].sort((left, right) => right.updatedAtMs - left.updatedAtMs)) {
    if (row.archived) continue;
    const key = keyByPath.get(resolve(row.cwd));
    if (!key || activeThreadByProject[key]) continue;
    activeThreadByProject[key] = row.id;
  }

  const activeProjectKey = projects.some((project) => project.key === existingState.activeProjectKey)
    ? existingState.activeProjectKey!
    : keyByPath.get(workspace) ?? projects[0]?.key ?? "";
  const backupStamp = options.backup === false ? undefined : await backupRefreshFiles(options.store);

  await options.store.writeJson("projects.json", { projects });
  await options.store.writeJson("bridge-state.json", {
    activeProjectKey,
    activeThreadByProject,
    recentListContext: {
      kind: "project",
      entries: projects.map((project) => project.key)
    }
  });

  return {
    projectCount: projects.length,
    mappedThreadCount: Object.keys(activeThreadByProject).length,
    activeProjectKey,
    backupStamp
  };
}

function buildProjects(candidatePaths: string[], existingProjects: BridgeProject[]): BridgeProject[] {
  const existingKeyByPath = new Map(existingProjects.map((project) => [resolve(project.path), project.key]));
  const usedPaths = new Set<string>();
  const usedKeys = new Set<string>();
  const projects: BridgeProject[] = [];

  for (const candidatePath of candidatePaths) {
    if (!candidatePath?.trim()) continue;
    const path = resolve(candidatePath.trim());
    if (usedPaths.has(path) || !existsSync(path)) continue;
    const key = uniqueKey(existingKeyByPath.get(path) ?? keyFromPath(path), usedKeys);
    usedPaths.add(path);
    usedKeys.add(key);
    projects.push({ key, path });
  }

  return projects;
}

async function readThreadRows(stateDbPath: string): Promise<CodexThreadIndexRow[]> {
  if (!existsSync(stateDbPath)) return [];
  const sql = [
    "select id, title, cwd, updated_at_ms as updatedAtMs, archived",
    "from threads",
    "where cwd is not null and trim(cwd) <> ''",
    "order by updated_at_ms desc, id desc;"
  ].join(" ");
  const { stdout } = await execFileAsync("sqlite3", ["-json", stateDbPath, sql], { encoding: "utf8" });
  const rows = stdout.trim() ? JSON.parse(stdout) as Array<Record<string, unknown>> : [];
  return rows
    .filter((row) => typeof row.id === "string" && typeof row.cwd === "string")
    .map((row) => ({
      id: String(row.id),
      title: typeof row.title === "string" ? row.title : undefined,
      cwd: String(row.cwd),
      updatedAtMs: Number(row.updatedAtMs ?? 0),
      archived: Boolean(Number(row.archived ?? 0))
    }));
}

async function readDesktopWorkspaceRoots(globalStatePath: string): Promise<string[]> {
  if (!existsSync(globalStatePath)) return [];
  try {
    const state = JSON.parse(await readFile(globalStatePath, "utf8")) as Record<string, unknown>;
    return [
      ...toStringArray(state["active-workspace-roots"]),
      ...toStringArray(state["electron-saved-workspace-roots"]),
      ...toStringArray(state["project-order"])
    ];
  } catch {
    return [];
  }
}

async function backupRefreshFiles(store: BridgeStore): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  await backupIfExists(store.path("projects.json"), `${store.path("projects.json")}.bak-${stamp}`);
  await backupIfExists(store.path("bridge-state.json"), `${store.path("bridge-state.json")}.bak-${stamp}`);
  return stamp;
}

async function backupIfExists(source: string, target: string): Promise<void> {
  if (!existsSync(source)) return;
  await copyFile(source, target);
}

function defaultStateDbPath(): string {
  return join(homedir(), ".codex", "state_5.sqlite");
}

function defaultGlobalStatePath(): string {
  return join(homedir(), ".codex", "codex-global-state.json");
}

function keyFromPath(projectPath: string): string {
  const candidate = basename(projectPath)
    .trim()
    .replace(/[\s/\\:]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return candidate || "project";
}

function uniqueKey(baseKey: string, usedKeys: Set<string>): string {
  let key = baseKey.trim() || "project";
  if (!usedKeys.has(key)) return key;
  let suffix = 2;
  while (usedKeys.has(`${key}-${suffix}`)) suffix += 1;
  return `${key}-${suffix}`;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import type { ProjectDiscoveryConfig } from "./config.js";
import type { BridgeStore } from "./storage.js";

export type BridgeProject = {
  key: string;
  path: string;
};

type ProjectsFile = {
  projects?: BridgeProject[];
};

type CodexDesktopGlobalState = {
  "active-workspace-roots"?: unknown;
  "electron-saved-workspace-roots"?: unknown;
  "project-order"?: unknown;
};

const PROJECT_MARKER_FILES = new Set(["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "pom.xml"]);
const PROJECT_MARKER_DIR_SUFFIXES = [".xcodeproj", ".xcworkspace"];
const IGNORED_SCAN_DIRS = new Set([".git", ".next", "node_modules", "dist", "build", "coverage"]);

export class ProjectRegistry {
  constructor(
    private readonly store: BridgeStore,
    private readonly defaultWorkspace: string,
    private readonly discovery: ProjectDiscoveryConfig = {}
  ) {}

  async list(): Promise<BridgeProject[]> {
    const manualProjects = await this.readStoredProjects();
    const discoveredProjects = await this.discoverProjects();
    return mergeProjects(this.defaultProject(), manualProjects, discoveredProjects);
  }

  async add(key: string, projectPath: string): Promise<BridgeProject[]> {
    const project = normalizeProject({ key, path: projectPath });
    validateProjectKey(project.key);
    const projects = await this.readStoredProjects();
    const existingIndex = projects.findIndex((item) => item.key === project.key);
    if (existingIndex >= 0) {
      projects[existingIndex] = project;
    } else {
      projects.push(project);
    }
    await this.save(projects);
    return projects;
  }

  async save(projects: BridgeProject[]): Promise<void> {
    await this.store.writeJson("projects.json", { projects: normalizeProjects(projects) });
  }

  async resolveTarget(target: string): Promise<BridgeProject> {
    const projects = await this.list();
    if (/^\d+$/.test(target)) {
      const index = Number(target) - 1;
      if (index < 0 || index >= projects.length) {
        throw new Error(`Project index out of range: ${target}`);
      }
      return projects[index];
    }
    const project = projects.find((item) => item.key === target);
    if (!project) throw new Error(`Unknown project: ${target}`);
    return project;
  }

  defaultProject(): BridgeProject {
    const projectPath = resolve(this.defaultWorkspace);
    return {
      key: basename(projectPath) || "default",
      path: projectPath
    };
  }

  private async readStoredProjects(): Promise<BridgeProject[]> {
    const stored = await this.store.readJson<ProjectsFile>("projects.json", {});
    return normalizeProjects(stored.projects ?? []);
  }

  private async discoverProjects(): Promise<BridgeProject[]> {
    const [historyProjects, desktopProjects, rootProjects] = await Promise.all([
      this.discoverFromCodexHistory(),
      this.discoverFromCodexDesktopGlobalState(),
      this.discoverFromRoots()
    ]);
    return [...historyProjects, ...desktopProjects, ...rootProjects];
  }

  private async discoverFromCodexHistory(): Promise<BridgeProject[]> {
    if (!this.discovery.codexHistory) return [];
    const sessionsDir = resolve(this.discovery.codexSessionsDir ?? join(homedir(), ".codex", "sessions"));
    const files = await collectFiles(sessionsDir, (path) => path.endsWith(".jsonl"));
    const discoveredPaths = new Set<string>();
    for (const file of files) {
      const lines = createInterface({
        input: createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity
      });
      for await (const line of lines) {
        for (const cwd of extractCwds(line)) {
          const projectPath = await findProjectRoot(resolve(cwd));
          if (projectPath) discoveredPaths.add(projectPath);
        }
      }
    }
    return [...discoveredPaths].sort().map((projectPath) => ({
      key: keyFromPath(projectPath),
      path: projectPath
    }));
  }

  private async discoverFromRoots(): Promise<BridgeProject[]> {
    const roots = this.discovery.discoveryRoots ?? [];
    if (roots.length === 0) return [];
    const maxDepth = this.discovery.discoveryMaxDepth ?? 3;
    const projects: BridgeProject[] = [];
    for (const root of roots.map((item) => resolve(item)).sort()) {
      if (!(await exists(root))) continue;
      const entries = await safeReadDir(root);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        projects.push(...await scanForProjects(join(root, entry.name), maxDepth - 1));
      }
    }
    return projects.sort((left, right) => left.key.localeCompare(right.key) || left.path.localeCompare(right.path));
  }

  private async discoverFromCodexDesktopGlobalState(): Promise<BridgeProject[]> {
    const globalStatePath = resolve(this.discovery.codexDesktopGlobalStatePath ?? join(homedir(), ".codex", "codex-global-state.json"));
    if (!(await exists(globalStatePath))) return [];

    let parsed: CodexDesktopGlobalState;
    try {
      parsed = JSON.parse(await readFile(globalStatePath, "utf8")) as CodexDesktopGlobalState;
    } catch {
      return [];
    }

    const candidateRoots = new Set<string>();
    for (const root of extractDesktopWorkspaceRoots(parsed)) {
      const projectPath = await findProjectRoot(resolve(root), 1);
      if (projectPath) candidateRoots.add(projectPath);
    }

    return [...candidateRoots].sort().map((projectPath) => ({
      key: keyFromPath(projectPath),
      path: projectPath
    }));
  }
}

export function formatProjectLine(index: number, project: BridgeProject, active: boolean): string {
  const marker = active ? " *" : "";
  return `${index + 1}. ${project.key}${marker}\n   ${project.path}`;
}

function normalizeProjects(projects: BridgeProject[]): BridgeProject[] {
  const result: BridgeProject[] = [];
  const seenKeys = new Set<string>();
  for (const project of projects) {
    const normalized = normalizeProject(project);
    if (!normalized.key || seenKeys.has(normalized.key)) continue;
    seenKeys.add(normalized.key);
    result.push(normalized);
  }
  return result;
}

function normalizeProject(project: BridgeProject): BridgeProject {
  return {
    key: String(project.key).trim(),
    path: resolve(String(project.path).trim())
  };
}

function validateProjectKey(key: string): void {
  if (!key || /[\s/\\:]/.test(key)) {
    throw new Error("Project key must not be empty or contain whitespace, slash, backslash, or colon.");
  }
}

function mergeProjects(defaultProject: BridgeProject, manualProjects: BridgeProject[], discoveredProjects: BridgeProject[]): BridgeProject[] {
  const result: BridgeProject[] = [];
  const seenPaths = new Set<string>();
  const seenKeys = new Set<string>();
  for (const project of [...manualProjects, ...discoveredProjects]) {
    const normalized = normalizeProject(project);
    if (seenPaths.has(normalized.path)) continue;
    const key = uniqueKey(normalized.key, seenKeys);
    seenPaths.add(normalized.path);
    seenKeys.add(key);
    result.push({ key, path: normalized.path });
  }
  return ensureDefaultProject(result, defaultProject);
}

function ensureDefaultProject(projects: BridgeProject[], defaultProject: BridgeProject): BridgeProject[] {
  const normalizedDefault = normalizeProject(defaultProject);
  if (projects.some((project) => project.path === normalizedDefault.path)) return projects;
  const usedKeys = new Set(projects.map((project) => project.key));
  return [{ key: uniqueKey(normalizedDefault.key, usedKeys), path: normalizedDefault.path }, ...projects];
}

function uniqueKey(baseKey: string, usedKeys: Set<string>): string {
  let key = String(baseKey).trim();
  if (!key) key = "project";
  if (!usedKeys.has(key)) return key;
  let suffix = 2;
  while (usedKeys.has(`${key}-${suffix}`)) suffix += 1;
  return `${key}-${suffix}`;
}

function keyFromPath(projectPath: string): string {
  const candidate = basename(projectPath)
    .trim()
    .replace(/[\s/\\:]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return candidate || "project";
}

function extractCwds(line: string): string[] {
  const matches = line.matchAll(/"cwd":"([^"]+)"/g);
  const result: string[] = [];
  for (const match of matches) {
    try {
      result.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      // Ignore malformed lines and keep scanning the rest of the history.
    }
  }
  return result;
}

function extractDesktopWorkspaceRoots(state: CodexDesktopGlobalState): string[] {
  return [
    ...toStringArray(state["active-workspace-roots"]),
    ...toStringArray(state["electron-saved-workspace-roots"]),
    ...toStringArray(state["project-order"])
  ];
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

async function collectFiles(root: string, predicate: (path: string) => boolean): Promise<string[]> {
  if (!(await exists(root))) return [];
  const results: string[] = [];
  await walkFiles(root, predicate, results);
  return results.sort();
}

async function walkFiles(current: string, predicate: (path: string) => boolean, results: string[]): Promise<void> {
  for (const entry of await safeReadDir(current)) {
    const entryPath = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(entryPath, predicate, results);
      continue;
    }
    if (entry.isFile() && predicate(entryPath)) results.push(entryPath);
  }
}

async function scanForProjects(dir: string, depthRemaining: number): Promise<BridgeProject[]> {
  if (depthRemaining < 0 || !(await exists(dir))) return [];
  const entries = await safeReadDir(dir);
  if (isProjectDirectory(entries)) {
    return [{ key: keyFromPath(dir), path: dir }];
  }
  if (depthRemaining === 0) return [];
  const results: BridgeProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || IGNORED_SCAN_DIRS.has(entry.name)) continue;
    results.push(...await scanForProjects(join(dir, entry.name), depthRemaining - 1));
  }
  return results;
}

function isProjectDirectory(entries: Awaited<ReturnType<typeof safeReadDir>>): boolean {
  return entries.some((entry) => {
    if (entry.isFile() && PROJECT_MARKER_FILES.has(entry.name)) return true;
    if (entry.isDirectory() && entry.name === ".git") return true;
    if (entry.isDirectory() && PROJECT_MARKER_DIR_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) return true;
    return false;
  });
}

async function findProjectRoot(start: string, maxAscend = 4): Promise<string | null> {
  let current = start;
  for (let step = 0; step <= maxAscend; step += 1) {
    if (!(await exists(current))) return null;
    if (isProjectDirectory(await safeReadDir(current))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function safeReadDir(path: string) {
  try {
    return (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

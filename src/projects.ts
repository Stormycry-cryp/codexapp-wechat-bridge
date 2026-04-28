import { basename, resolve } from "node:path";
import type { BridgeStore } from "./storage.js";

export type BridgeProject = {
  key: string;
  path: string;
};

type ProjectsFile = {
  projects?: BridgeProject[];
};

export class ProjectRegistry {
  constructor(private readonly store: BridgeStore, private readonly defaultWorkspace: string) {}

  async list(): Promise<BridgeProject[]> {
    const stored = await this.store.readJson<ProjectsFile>("projects.json", {});
    return ensureDefaultProject(normalizeProjects(stored.projects ?? []), this.defaultProject());
  }

  async add(key: string, projectPath: string): Promise<BridgeProject[]> {
    const project = normalizeProject({ key, path: projectPath });
    validateProjectKey(project.key);
    const projects = await this.list();
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
}

export function formatProjectLine(index: number, project: BridgeProject, active: boolean): string {
  const marker = active ? " *" : "";
  return `${index + 1}. ${project.key}${marker}\n   ${project.path}`;
}

function ensureDefaultProject(projects: BridgeProject[], defaultProject: BridgeProject): BridgeProject[] {
  if (projects.length === 0) return [defaultProject];
  if (projects.some((project) => project.path === defaultProject.path)) return projects;
  return [defaultProject, ...projects];
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

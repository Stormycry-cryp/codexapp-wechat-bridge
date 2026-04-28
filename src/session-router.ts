import type { CodexApprovalRequest, CodexBridgeClient, CodexImageOutput, CodexInputImage, CodexTurnOptions } from "./codex/app-server-client.js";
import { ProjectRegistry, formatProjectLine, type BridgeProject } from "./projects.js";
import type { BridgeStore } from "./storage.js";

type BridgeState = {
  activeThreadId?: string;
  activeProjectKey?: string;
  activeThreadByProject?: Record<string, string>;
};

const PROJECT_COMMANDS = ["/projects", "/project", "项目", "/项目", "项目列表", "/项目列表"];
const THREAD_COMMANDS = ["/threads", "/thread", "/thread列表", "线程", "/线程", "线程列表", "/线程列表"];
const RESUME_COMMANDS = ["/resume", "切线程", "/切线程", "恢复线程", "/恢复线程"];
const NEW_THREAD_COMMANDS = new Set(["/new", "新线程", "/新线程"]);
const STOP_COMMANDS = new Set(["/stop", "停下", "/停下", "停止", "/停止"]);

export type SessionRouterHooks = {
  onTurnStart?: () => void | Promise<void>;
  onDelta?: (delta: string) => void | Promise<void>;
  onApproval?: (request: CodexApprovalRequest) => void | Promise<void>;
  onImageOutput?: (output: CodexImageOutput) => void | Promise<void>;
};

export type SessionRouterOptions = {
  workspace?: string;
  codexFactory?: (project: BridgeProject) => CodexBridgeClient;
};

export type SessionRouterInput = {
  text: string;
  images?: CodexInputImage[];
};

export class SessionRouter {
  private codex: CodexBridgeClient;
  private readonly workspace: string;
  private readonly codexFactory?: (project: BridgeProject) => CodexBridgeClient;
  private activeProjectKey = "";

  constructor(codex: CodexBridgeClient, private readonly store?: BridgeStore, options: SessionRouterOptions = {}) {
    this.codex = codex;
    this.workspace = options.workspace ?? process.cwd();
    this.codexFactory = options.codexFactory;
  }

  shutdown(): void {
    this.codex.shutdown?.();
  }

  async handleText(text: string, hooks: SessionRouterHooks = {}): Promise<string> {
    return this.handleInput({ text }, hooks);
  }

  async handleInput(input: SessionRouterInput, hooks: SessionRouterHooks = {}): Promise<string> {
    const images = input.images ?? [];
    const trimmed = input.text.trim();
    if (!trimmed && images.length === 0) return "";

    if (images.length === 0) {
      const commandReply = await this.handleCommand(trimmed, hooks);
      if (commandReply !== null) return commandReply;
    }

    return this.handleOrdinaryInput(trimmed || "请分析这张图片。", images, hooks);
  }

  private async handleCommand(trimmed: string, _hooks: SessionRouterHooks): Promise<string | null> {
    if (!trimmed) return "";

    if (trimmed === "/help") {
      return [
        "Commands:",
        "/new or 新线程 - start a new Codex thread",
        "/threads, /thread, or 线程列表 - list recent threads",
        "/resume <index|thread_id> or 线程 <index|thread_id> - switch thread",
        "/projects or 项目列表 - list configured projects",
        "/project <index|key> or 项目 <index|key> - switch project",
        "/status - show bridge status",
        "/approve - approve pending Codex request",
        "/deny - deny pending Codex request",
        "1 / 2 - approve / deny while awaiting approval",
        "/stop or 停下 - interrupt the active turn"
      ].join("\n");
    }

    if (trimmed === "/approve") {
      const codex = await this.ensureCodexForActiveProject();
      return await (codex.approvePending?.() ?? "This Codex client does not support approvals.");
    }

    if (trimmed === "/deny") {
      const codex = await this.ensureCodexForActiveProject();
      return await (codex.denyPending?.() ?? "This Codex client does not support approvals.");
    }

    if (trimmed === "1" || trimmed === "2") {
      const codex = await this.ensureCodexForActiveProject();
      if (codex.status().state === "awaiting_approval") {
        return trimmed === "1"
          ? await (codex.approvePending?.() ?? "This Codex client does not support approvals.")
          : await (codex.denyPending?.() ?? "This Codex client does not support approvals.");
      }
    }

    const projectTarget = commandTarget(trimmed, PROJECT_COMMANDS);
    if (projectTarget !== null && !projectTarget) {
      const { projects, activeProject } = await this.loadProjectState();
      return [
        `Current project: ${activeProject.key}`,
        ...projects.map((project, index) => formatProjectLine(index, project, project.key === activeProject.key))
      ].join("\n");
    }

    if (projectTarget) {
      const codex = await this.ensureCodexForActiveProject();
      const status = codex.status();
      if (status.state === "busy" || status.state === "awaiting_approval") {
        return "Codex is busy. Send /stop to interrupt, or wait and switch project later.";
      }
      const project = await this.registry().resolveTarget(projectTarget);
      await this.switchProject(project);
      const activeThreadId = await this.loadActiveThreadId();
      return `Switched project: ${project.key}\nPath: ${project.path}\nThread: ${activeThreadId ? shortThreadId(activeThreadId) : "(none)"}`;
    }

    if (trimmed === "/status") {
      const { activeProject } = await this.loadProjectState();
      const codex = await this.ensureCodexForActiveProject();
      const status = codex.status();
      const activeThreadId = status.activeThreadId ?? (await this.loadActiveThreadId());
      const state = status.state === "disconnected"
        ? "idle (codex app-server lazy)"
        : status.state;
      return `Bridge: ${state}\nProject: ${activeProject.key}\nPath: ${activeProject.path}\nThread: ${activeThreadId || "(none)"}`;
    }

    if (NEW_THREAD_COMMANDS.has(trimmed)) {
      const codex = await this.ensureCodexForActiveProject();
      const { threadId } = await codex.startThread();
      await this.saveActiveThreadId(threadId);
      return `Started new Codex thread: ${threadId}`;
    }

    const threadTarget = commandTarget(trimmed, THREAD_COMMANDS);
    if (threadTarget !== null && !threadTarget) {
      const codex = await this.ensureCodexForActiveProject();
      const threads = await codex.listThreads();
      if (threads.length === 0) return "No recent Codex threads.";
      const activeThreadId = codex.status().activeThreadId ?? (await this.loadActiveThreadId());
      return [
        `Current: ${activeThreadId ? shortThreadId(activeThreadId) : "(none)"}`,
        ...threads.map((thread, index) => formatThreadLine(index, thread.id, thread.name, thread.preview, thread.updatedAt, thread.id === activeThreadId))
      ].join("\n");
    }

    const resumeTarget = commandTarget(trimmed, RESUME_COMMANDS) ?? threadTarget;
    if (resumeTarget) {
      const target = resumeTarget;
      if (!target) return "Usage: /resume <index|thread_id>";
      const threadIdToResume = await this.resolveThreadTarget(target);
      const codex = await this.ensureCodexForActiveProject();
      const { threadId } = await codex.resumeThread(threadIdToResume);
      await this.saveActiveThreadId(threadId);
      return `Resumed Codex thread: ${threadId}`;
    }

    if (STOP_COMMANDS.has(trimmed)) {
      const codex = await this.ensureCodexForActiveProject();
      return await codex.stop();
    }

    return null;
  }

  private async handleOrdinaryInput(text: string, images: CodexInputImage[], hooks: SessionRouterHooks): Promise<string> {
    const codex = await this.ensureCodexForActiveProject();
    const status = codex.status();
    if (status.state === "busy" || status.state === "awaiting_approval") {
      return "Codex is busy. Send /stop to interrupt, or wait and try again.";
    }

    let threadId = status.activeThreadId;
    if (!threadId) {
      const persistedThreadId = await this.loadActiveThreadId();
      if (persistedThreadId) {
        threadId = (await codex.resumeThread(persistedThreadId)).threadId;
      } else {
        threadId = (await codex.startThread()).threadId;
      }
      await this.saveActiveThreadId(threadId);
    }
    await hooks.onTurnStart?.();
    const turnOptions = buildTurnOptions(hooks);
    if (images.length > 0) {
      return await codex.sendTurn(threadId, text, turnOptions, images);
    }
    if (turnOptions) {
      return await codex.sendTurn(threadId, text, turnOptions);
    }
    return await codex.sendTurn(threadId, text);
  }

  private async resolveThreadTarget(target: string): Promise<string> {
    if (/^\d+$/.test(target)) {
      const index = Number(target) - 1;
      const codex = await this.ensureCodexForActiveProject();
      const threads = await codex.listThreads();
      if (index < 0 || index >= threads.length) {
        throw new Error(`Thread index out of range: ${target}`);
      }
      return threads[index].id;
    }
    return target;
  }

  private async loadActiveThreadId(): Promise<string> {
    if (!this.store) return "";
    const { state, activeProject } = await this.loadProjectState();
    return state.activeThreadByProject?.[activeProject.key] ?? "";
  }

  private async saveActiveThreadId(activeThreadId: string): Promise<void> {
    if (!this.store) return;
    const { state, activeProject } = await this.loadProjectState();
    await this.saveState({
      ...state,
      activeProjectKey: activeProject.key,
      activeThreadByProject: {
        ...(state.activeThreadByProject ?? {}),
        [activeProject.key]: activeThreadId
      }
    });
  }

  private async ensureCodexForActiveProject(): Promise<CodexBridgeClient> {
    if (!this.codexFactory) return this.codex;
    const { activeProject } = await this.loadProjectState();
    if (this.activeProjectKey !== activeProject.key) {
      if (this.activeProjectKey) this.codex.shutdown?.();
      this.codex = this.codexFactory(activeProject);
      this.activeProjectKey = activeProject.key;
    }
    return this.codex;
  }

  private async switchProject(project: BridgeProject): Promise<void> {
    const { state } = await this.loadProjectState();
    await this.saveState({
      ...state,
      activeProjectKey: project.key,
      activeThreadByProject: state.activeThreadByProject ?? {}
    });
    if (this.codexFactory && this.activeProjectKey !== project.key) {
      if (this.activeProjectKey) this.codex.shutdown?.();
      this.codex = this.codexFactory(project);
      this.activeProjectKey = project.key;
    }
  }

  private async loadProjectState(): Promise<{ projects: BridgeProject[]; state: BridgeState; activeProject: BridgeProject }> {
    const projects = this.store ? await this.registry().list() : [this.registry().defaultProject()];
    const rawState = this.store ? await this.store.readJson<BridgeState>("bridge-state.json", {}) : {};
    const defaultProject = projects.find((project) => project.path === this.registry().defaultProject().path) ?? projects[0];
    const activeProject = projects.find((project) => project.key === rawState.activeProjectKey) ?? defaultProject;
    const activeThreadByProject = { ...(rawState.activeThreadByProject ?? {}) };
    if (rawState.activeThreadId && !activeThreadByProject[activeProject.key]) {
      activeThreadByProject[activeProject.key] = rawState.activeThreadId;
    }
    const state: BridgeState = {
      activeProjectKey: activeProject.key,
      activeThreadByProject
    };
    const needsMigration = rawState.activeThreadId !== undefined
      || rawState.activeProjectKey !== state.activeProjectKey
      || JSON.stringify(rawState.activeThreadByProject ?? {}) !== JSON.stringify(activeThreadByProject);
    if (this.store && needsMigration) {
      await this.saveState(state);
    }
    return { projects, state, activeProject };
  }

  private async saveState(state: BridgeState): Promise<void> {
    if (!this.store) return;
    await this.store.writeJson("bridge-state.json", {
      activeProjectKey: state.activeProjectKey,
      activeThreadByProject: state.activeThreadByProject ?? {}
    });
  }

  private registry(): ProjectRegistry {
    if (!this.store) {
      return new ProjectRegistry({
        path: () => "",
        readJson: async () => ({}),
        writeJson: async () => {}
      } as unknown as BridgeStore, this.workspace);
    }
    return new ProjectRegistry(this.store, this.workspace);
  }
}

function formatThreadLine(index: number, id: string, name: string, preview: string, updatedAt: number | undefined, active: boolean): string {
  const marker = active ? " *" : "";
  const previewText = preview && preview !== name ? ` - ${truncate(preview, 28)}` : "";
  const timeText = updatedAt ? ` · ${formatTime(updatedAt)}` : "";
  return `${index + 1}. ${name}${marker}\n   ${shortThreadId(id)}${timeText}${previewText}`;
}

function commandTarget(trimmed: string, aliases: string[]): string | null {
  if (aliases.includes(trimmed)) return "";
  for (const alias of [...aliases].sort((left, right) => right.length - left.length)) {
    if (trimmed.startsWith(`${alias} `)) {
      return trimmed.slice(alias.length).trim();
    }
  }
  return null;
}

function buildTurnOptions(hooks: SessionRouterHooks): CodexTurnOptions | undefined {
  if (!hooks.onDelta && !hooks.onApproval && !hooks.onImageOutput) return undefined;
  return {
    ...(hooks.onDelta ? { onDelta: hooks.onDelta } : {}),
    ...(hooks.onApproval ? { onApproval: hooks.onApproval } : {}),
    ...(hooks.onImageOutput ? { onImageOutput: hooks.onImageOutput } : {})
  };
}

function shortThreadId(threadId: string): string {
  return threadId.length <= 8 ? threadId : threadId.slice(0, 8);
}

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function formatTime(timestamp: number): string {
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  return new Date(milliseconds).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

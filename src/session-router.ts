import type { CodexApprovalRequest, CodexBridgeClient, CodexBridgeStatus, CodexFileOutput, CodexImageOutput, CodexInputFile, CodexInputImage, CodexTurnOptions } from "./codex/app-server-client.js";
import type { ProjectDiscoveryConfig } from "./config.js";
import { ProjectRegistry, formatProjectLine, type BridgeProject } from "./projects.js";
import { refreshProjectThreadIndex, type CodexThreadIndexRow } from "./refresh.js";
import type { BridgeStore } from "./storage.js";

type BridgeState = {
  activeThreadId?: string;
  activeProjectKey?: string;
  activeThreadByProject?: Record<string, string>;
  recentListContext?: {
    kind: "project" | "thread";
    entries: string[];
  };
};

const PROJECT_COMMANDS = ["/projects", "/project", "项目", "/项目", "项目列表", "/项目列表"];
const THREAD_COMMANDS = ["/threads", "/thread", "/thread列表", "线程", "/线程", "线程列表", "/线程列表"];
const RESUME_COMMANDS = ["/resume", "切线程", "/切线程", "恢复线程", "/恢复线程"];
const STEER_COMMANDS = ["/steer", "引导", "/引导"];
const NEW_THREAD_COMMANDS = new Set(["/new", "新线程", "/新线程"]);
const STOP_COMMANDS = new Set(["/stop", "停下", "/停下", "停止", "/停止"]);
const REFRESH_COMMANDS = new Set(["/refresh", "刷新", "/刷新", "刷新项目", "/刷新项目", "刷新线程", "/刷新线程"]);

export function helpMessage(): string {
  return [
    "Codex 微信桥帮助",
    "",
    "常用命令：",
    "- /new 或 新线程：新建 Codex 线程",
    "- /threads、/thread、线程列表：查看最近线程，随后可直接回复数字切换",
    "- /resume <序号|thread_id>、线程 <序号|thread_id>：切换线程",
    "- /projects、/project、项目列表：查看项目，随后可直接回复数字切换",
    "- /project <序号|key>、项目 <序号|key>：切换项目",
    "- /refresh、刷新项目、刷新线程：主动同步 Codex 项目和线程索引",
    "- /status：查看 bridge、项目和线程状态",
    "- /steer <内容>、引导 <内容>：给当前 busy 中的任务追加引导",
    "- /approve、/deny：处理待审批请求",
    "- 1 / 2：在审批态下快捷同意 / 拒绝",
    "- /stop、停下：中断当前任务",
    "",
    "近期更新：",
    "- 新增 /steer <内容> 与 引导 <内容>：只在任务 busy 时向当前 turn 插入额外引导，普通 busy 消息仍会拦截",
    "- 流式回传更稳：尽量避免过短碎片单独发送，编号列表会尽量按完整条目回传"
  ].join("\n");
}

export type SessionRouterHooks = {
  onTurnStart?: () => void | Promise<void>;
  onDelta?: (delta: string) => void | Promise<void>;
  onApproval?: (request: CodexApprovalRequest) => void | Promise<void>;
  onImageOutput?: (output: CodexImageOutput) => void | Promise<void>;
  onFileOutput?: (output: CodexFileOutput) => void | Promise<void>;
};

export type SessionRouterOptions = {
  workspace?: string;
  codexFactory?: (project: BridgeProject) => CodexBridgeClient;
  projectDiscovery?: ProjectDiscoveryConfig;
  refreshStateDbPath?: string;
  refreshGlobalStatePath?: string;
  refreshThreadRows?: CodexThreadIndexRow[];
};

export type SessionRouterInput = {
  text: string;
  images?: CodexInputImage[];
  files?: CodexInputFile[];
};

export class SessionRouter {
  private codex: CodexBridgeClient;
  private readonly workspace: string;
  private readonly codexFactory?: (project: BridgeProject) => CodexBridgeClient;
  private readonly projectDiscovery?: ProjectDiscoveryConfig;
  private readonly refreshStateDbPath?: string;
  private readonly refreshGlobalStatePath?: string;
  private readonly refreshThreadRows?: CodexThreadIndexRow[];
  private activeProjectKey = "";
  private recentListContext?: BridgeState["recentListContext"];

  constructor(codex: CodexBridgeClient, private readonly store?: BridgeStore, options: SessionRouterOptions = {}) {
    this.codex = codex;
    this.workspace = options.workspace ?? process.cwd();
    this.codexFactory = options.codexFactory;
    this.projectDiscovery = options.projectDiscovery;
    this.refreshStateDbPath = options.refreshStateDbPath;
    this.refreshGlobalStatePath = options.refreshGlobalStatePath;
    this.refreshThreadRows = options.refreshThreadRows;
  }

  shutdown(): void {
    this.codex.shutdown?.();
  }

  async codexStatus(): Promise<CodexBridgeStatus> {
    const codex = await this.ensureCodexForActiveProject();
    return codex.status();
  }

  async notifyCodexTaskError(message: string, code?: string): Promise<void> {
    const codex = await this.ensureCodexForActiveProject();
    if (typeof codex.notifyTaskError === "function") {
      codex.notifyTaskError(message, code);
    }
  }

  async handleText(text: string, hooks: SessionRouterHooks = {}): Promise<string> {
    return this.handleInput({ text }, hooks);
  }

  async handleInput(input: SessionRouterInput, hooks: SessionRouterHooks = {}): Promise<string> {
    const images = input.images ?? [];
    const files = input.files ?? [];
    const trimmed = input.text.trim();
    if (!trimmed && images.length === 0 && files.length === 0) return "";

    if (images.length === 0 && files.length === 0) {
      const commandReply = await this.handleCommand(trimmed, hooks);
      if (commandReply !== null) return commandReply;
    }

    return this.handleOrdinaryInput(defaultPrompt(trimmed, images, files), images, files, hooks);
  }

  private async handleCommand(trimmed: string, _hooks: SessionRouterHooks): Promise<string | null> {
    if (!trimmed) return "";

    if (trimmed === "/help") {
      return helpMessage();
    }

    if (REFRESH_COMMANDS.has(trimmed)) {
      return await this.handleRefreshCommand();
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

    const steerTarget = commandTarget(trimmed, STEER_COMMANDS);
    if (steerTarget !== null) {
      return await this.handleSteerCommand(steerTarget);
    }

    const recentListTarget = await this.resolveRecentListTarget(trimmed);
    if (recentListTarget) {
      return recentListTarget.kind === "project"
        ? await this.switchProjectByTarget(recentListTarget.target)
        : await this.resumeThreadByTarget(recentListTarget.target);
    }

    const projectTarget = commandTarget(trimmed, PROJECT_COMMANDS);
    if (projectTarget !== null && !projectTarget) {
      const { projects, activeProject } = await this.loadProjectState();
      await this.saveRecentListContext({
        kind: "project",
        entries: projects.map((project) => project.key)
      });
      return [
        `Current project: ${activeProject.key}`,
        ...projects.map((project, index) => formatProjectLine(index, project, project.key === activeProject.key))
      ].join("\n");
    }

    if (projectTarget) {
      return await this.switchProjectByTarget(projectTarget);
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
      await this.saveRecentListContext({
        kind: "thread",
        entries: threads.map((thread) => thread.id)
      });
      const activeThreadId = codex.status().activeThreadId ?? (await this.loadActiveThreadId());
      return [
        `Current: ${activeThreadId ? shortThreadId(activeThreadId) : "(none)"}`,
        ...threads.map((thread, index) => formatThreadLine(index, thread.id, thread.name, thread.preview, thread.updatedAt, thread.id === activeThreadId))
      ].join("\n");
    }

    const resumeTarget = commandTarget(trimmed, RESUME_COMMANDS) ?? threadTarget;
    if (resumeTarget) {
      return await this.resumeThreadByTarget(resumeTarget);
    }

    if (STOP_COMMANDS.has(trimmed)) {
      const codex = await this.ensureCodexForActiveProject();
      return await codex.stop();
    }

    return null;
  }

  private async handleOrdinaryInput(text: string, images: CodexInputImage[], files: CodexInputFile[], hooks: SessionRouterHooks): Promise<string> {
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
    if (files.length > 0) {
      return await codex.sendTurn(threadId, text, turnOptions, images, files);
    }
    if (images.length > 0) {
      return await codex.sendTurn(threadId, text, turnOptions, images);
    }
    if (turnOptions) {
      return await codex.sendTurn(threadId, text, turnOptions);
    }
    return await codex.sendTurn(threadId, text);
  }

  private async handleSteerCommand(target: string): Promise<string> {
    const guidance = target.trim();
    if (!guidance) {
      return "Usage: /steer <text>";
    }
    const codex = await this.ensureCodexForActiveProject();
    const status = codex.status();
    if (status.state !== "busy" || !status.activeThreadId || !status.activeTurnId) {
      return "No active Codex turn to steer.";
    }
    if (!codex.steerTurn) {
      return "This Codex client does not support steer.";
    }
    return await codex.steerTurn(status.activeThreadId, status.activeTurnId, guidance);
  }

  private async handleRefreshCommand(): Promise<string> {
    if (!this.store) return "Refresh is unavailable without bridge storage.";
    const codex = await this.ensureCodexForActiveProject();
    const status = codex.status();
    if (status.state === "busy" || status.state === "awaiting_approval") {
      return "Codex is busy. Send /stop to interrupt, or wait and refresh later.";
    }
    const result = await refreshProjectThreadIndex({
      store: this.store,
      workspace: this.workspace,
      stateDbPath: this.refreshStateDbPath,
      globalStatePath: this.refreshGlobalStatePath,
      threadRows: this.refreshThreadRows
    });
    this.activeProjectKey = "";
    return [
      "已刷新 Codex 项目/线程索引。",
      `项目数：${result.projectCount}`,
      `线程映射：${result.mappedThreadCount}`,
      `当前项目：${result.activeProjectKey || "(none)"}`,
      "发送 /项目 查看项目列表，发送 /线程 查看当前项目线程。"
    ].join("\n");
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

  private async resolveRecentListTarget(trimmed: string): Promise<{ kind: "project" | "thread"; target: string } | null> {
    if (!/^\d+$/.test(trimmed)) return null;
    const context = await this.loadRecentListContext();
    if (!context) return null;
    const index = Number(trimmed) - 1;
    if (index < 0 || index >= context.entries.length) {
      return {
        kind: context.kind,
        target: "__out_of_range__"
      };
    }
    return {
      kind: context.kind,
      target: context.entries[index]
    };
  }

  private async switchProjectByTarget(target: string): Promise<string> {
    if (target === "__out_of_range__") {
      return "Project index out of range.";
    }
    const codex = await this.ensureCodexForActiveProject();
    const status = codex.status();
    if (status.state === "busy" || status.state === "awaiting_approval") {
      return "Codex is busy. Send /stop to interrupt, or wait and switch project later.";
    }
    const project = await this.registry().resolveTarget(target);
    await this.switchProject(project);
    const activeThreadId = await this.loadActiveThreadId();
    return `Switched project: ${project.key}\nPath: ${project.path}\nThread: ${activeThreadId ? shortThreadId(activeThreadId) : "(none)"}`;
  }

  private async resumeThreadByTarget(target: string): Promise<string> {
    if (!target) return "Usage: /resume <index|thread_id>";
    if (target === "__out_of_range__") {
      return "Thread index out of range.";
    }
    const threadIdToResume = await this.resolveThreadTarget(target);
    const codex = await this.ensureCodexForActiveProject();
    const { threadId } = await codex.resumeThread(threadIdToResume);
    await this.saveActiveThreadId(threadId);
    return `Resumed Codex thread: ${threadId}`;
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
      activeThreadByProject,
      recentListContext: rawState.recentListContext ?? this.recentListContext
    };
    const needsMigration = rawState.activeThreadId !== undefined
      || rawState.activeProjectKey !== state.activeProjectKey
      || JSON.stringify(rawState.activeThreadByProject ?? {}) !== JSON.stringify(activeThreadByProject)
      || JSON.stringify(rawState.recentListContext ?? null) !== JSON.stringify(state.recentListContext ?? null);
    if (this.store && needsMigration) {
      await this.saveState(state);
    }
    this.recentListContext = state.recentListContext;
    return { projects, state, activeProject };
  }

  private async saveState(state: BridgeState): Promise<void> {
    if (!this.store) return;
    await this.store.writeJson("bridge-state.json", {
      activeProjectKey: state.activeProjectKey,
      activeThreadByProject: state.activeThreadByProject ?? {},
      recentListContext: state.recentListContext
    });
  }

  private async loadRecentListContext(): Promise<BridgeState["recentListContext"] | undefined> {
    if (this.store) {
      const state = await this.store.readJson<BridgeState>("bridge-state.json", {});
      this.recentListContext = state.recentListContext;
      return state.recentListContext;
    }
    return this.recentListContext;
  }

  private async saveRecentListContext(context: NonNullable<BridgeState["recentListContext"]>): Promise<void> {
    this.recentListContext = context;
    if (!this.store) return;
    const { state, activeProject } = await this.loadProjectState();
    await this.saveState({
      ...state,
      activeProjectKey: activeProject.key,
      recentListContext: context
    });
  }

  private registry(): ProjectRegistry {
    if (!this.store) {
      return new ProjectRegistry({
        path: () => "",
        readJson: async () => ({}),
        writeJson: async () => {}
      } as unknown as BridgeStore, this.workspace, this.projectDiscovery);
    }
    return new ProjectRegistry(this.store, this.workspace, this.projectDiscovery);
  }
}

function defaultPrompt(text: string, images: CodexInputImage[], files: CodexInputFile[]): string {
  if (text) return text;
  if (images.length > 0 && files.length === 0) return "请分析这张图片。";
  if (files.length > 0 && images.length === 0) return "请查看我附带的文件。";
  return "请查看我附带的图片和文件。";
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
  if (!hooks.onDelta && !hooks.onApproval && !hooks.onImageOutput && !hooks.onFileOutput) return undefined;
  return {
    ...(hooks.onDelta ? { onDelta: hooks.onDelta } : {}),
    ...(hooks.onApproval ? { onApproval: hooks.onApproval } : {}),
    ...(hooks.onImageOutput ? { onImageOutput: hooks.onImageOutput } : {}),
    ...(hooks.onFileOutput ? { onFileOutput: hooks.onFileOutput } : {})
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

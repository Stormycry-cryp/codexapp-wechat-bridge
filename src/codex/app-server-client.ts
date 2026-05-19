import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { BRIDGE_VERSION } from "../version.js";
import { JsonLineRpcClient } from "./json-line-rpc.js";

export type CodexBridgeStatus = {
  state: "idle" | "busy" | "awaiting_approval" | "disconnected";
  activeThreadId?: string;
  activeTurnId?: string;
};

export type CodexThreadSummary = {
  id: string;
  name: string;
  preview: string;
  updatedAt?: number;
  cwd?: string;
};

export type CodexTurnOptions = {
  onDelta?: (delta: string) => void | Promise<void>;
  onApproval?: (request: CodexApprovalRequest) => void | Promise<void>;
  onImageOutput?: (output: CodexImageOutput) => void | Promise<void>;
  onFileOutput?: (output: CodexFileOutput) => void | Promise<void>;
};

export type CodexInputImage = {
  path?: string;
  url?: string;
};

export type CodexInputFile = {
  path: string;
  originalName?: string;
};

export type CodexImageOutput = {
  url?: string;
  path?: string;
  fallbackText: string;
};

export type CodexFileOutput = {
  path: string;
  fallbackText: string;
};

export type CodexApprovalRequest = {
  summary: string;
  method: string;
  command?: string;
  cwd?: string;
  reason?: string;
};

export interface CodexBridgeClient {
  status(): CodexBridgeStatus;
  startThread(): Promise<{ threadId: string }>;
  resumeThread(threadId: string): Promise<{ threadId: string }>;
  listThreads(): Promise<CodexThreadSummary[]>;
  sendTurn(threadId: string, text: string, options?: CodexTurnOptions, images?: CodexInputImage[], files?: CodexInputFile[]): Promise<string>;
  steerTurn?(threadId: string, turnId: string, text: string, images?: CodexInputImage[], files?: CodexInputFile[]): Promise<string>;
  approvePending?(): Promise<string>;
  denyPending?(): Promise<string>;
  stop(): Promise<string>;
  notifyTaskError?(message: string, code?: string): void;
  shutdown?(): void;
}

export type CodexAppServerClientOptions = {
  cwd: string;
  command?: string;
  args?: string[];
  turnIdleTimeoutMs?: number;
  desktopRefresh?: boolean;
};

export const CODEX_NO_TEXT_OUTPUT_MESSAGE = "Codex 已完成，本轮没有额外文本输出。";

export class CodexAppServerClient implements CodexBridgeClient {
  private static readonly INTENTIONAL_SHUTDOWN_MESSAGE = "Codex app-server stopped because the bridge is shutting down.";
  private child: ChildProcessWithoutNullStreams | null = null;
  private rpc: JsonLineRpcClient | null = null;
  private currentStatus: CodexBridgeStatus = { state: "disconnected" };
  private activeThreadId = "";
  private activeTurnId = "";
  private activeReply = "";
  private activeWaiter: ((text: string) => void) | null = null;
  private activeRejecter: ((error: Error) => void) | null = null;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private activeDeltaHandler: CodexTurnOptions["onDelta"] | null = null;
  private activeApprovalHandler: CodexTurnOptions["onApproval"] | null = null;
  private activeImageOutputHandler: CodexTurnOptions["onImageOutput"] | null = null;
  private activeFileOutputHandler: CodexTurnOptions["onFileOutput"] | null = null;
  private activeOutputChain: Promise<void> = Promise.resolve();
  private activeWorkspaceSnapshot: WorkspaceArtifactSnapshot = new Map();
  private pendingApproval: PendingApproval | null = null;
  private shuttingDown = false;

  constructor(private readonly options: CodexAppServerClientOptions) {}

  status(): CodexBridgeStatus {
    return { ...this.currentStatus, activeThreadId: this.activeThreadId || undefined, activeTurnId: this.activeTurnId || undefined };
  }

  async start(): Promise<void> {
    if (this.rpc) return;
    this.shuttingDown = false;
    this.child = spawn(this.options.command ?? defaultCodexCommand(), this.options.args ?? ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.options.cwd,
      env: process.env
    });
    this.rpc = new JsonLineRpcClient(this.child.stdin, this.child.stdout);
    this.rpc.on("notification", (method, params) => this.handleNotification(String(method), params));
    this.rpc.on("request", (id, method, params) => this.handleServerRequest(id as number | string, String(method), params));
    this.child.on("close", () => {
      this.currentStatus = { state: "disconnected" };
      this.rpc = null;
      this.child = null;
      if (this.shuttingDown) {
        this.shuttingDown = false;
        return;
      }
      this.finishTurn(new Error("Codex app-server disconnected before the turn completed."));
    });
    this.child.stderr.on("data", () => {});
    await this.rpc.request("initialize", {
      clientInfo: { name: "codex-wechat-bridge", title: "Codex WeChat Bridge", version: BRIDGE_VERSION },
      capabilities: { experimentalApi: true }
    });
    this.currentStatus = { state: "idle" };
  }

  async startThread(): Promise<{ threadId: string }> {
    const result = await this.request<{ thread: { id: string } }>("thread/start", buildThreadStartParams(this.options.cwd));
    this.activeThreadId = result.thread.id;
    this.currentStatus = { state: "idle", activeThreadId: this.activeThreadId };
    this.refreshDesktopThread(this.activeThreadId);
    return { threadId: this.activeThreadId };
  }

  async resumeThread(threadId: string): Promise<{ threadId: string }> {
    const result = await this.request<{ thread: { id: string } }>("thread/resume", buildThreadResumeParams(this.options.cwd, threadId));
    this.activeThreadId = result.thread.id;
    this.currentStatus = { state: "idle", activeThreadId: this.activeThreadId };
    this.refreshDesktopThread(this.activeThreadId);
    return { threadId: this.activeThreadId };
  }

  async listThreads(): Promise<CodexThreadSummary[]> {
    const result = await this.request<{ data?: Array<{ id: string; name?: string | null; preview?: string; updatedAt?: number; cwd?: string }> }>("thread/list", {
      limit: 10,
      sortKey: "updated_at",
      sortDirection: "desc",
      cwd: this.options.cwd
    });
    return (result.data ?? []).map((thread) => ({
      id: thread.id,
      name: thread.name?.trim() || titleFromPreview(thread.preview ?? "") || shortThreadId(thread.id),
      preview: thread.preview ?? "",
      updatedAt: thread.updatedAt,
      cwd: thread.cwd
    }));
  }

  async sendTurn(threadId: string, text: string, options: CodexTurnOptions = {}, images: CodexInputImage[] = [], files: CodexInputFile[] = []): Promise<string> {
    if (this.currentStatus.state === "busy" || this.currentStatus.state === "awaiting_approval") {
      throw new Error("codex is busy");
    }
    this.activeReply = "";
    this.activeDeltaHandler = options.onDelta ?? null;
    this.activeApprovalHandler = options.onApproval ?? null;
    this.activeImageOutputHandler = options.onImageOutput ?? null;
    this.activeFileOutputHandler = options.onFileOutput ?? null;
    this.activeOutputChain = Promise.resolve();
    this.activeWorkspaceSnapshot = await snapshotWorkspaceArtifacts(this.options.cwd);
    this.activeThreadId = threadId;
    this.currentStatus = { state: "busy", activeThreadId: threadId };
    const turnCompletion = new Promise<string>((resolve, reject) => {
      this.activeWaiter = resolve;
      this.activeRejecter = reject;
      this.armTurnIdleTimer();
    });
    try {
      const result = await this.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        cwd: this.options.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        input: buildTurnInput(text, images, files)
      });
      if (this.activeWaiter) {
        this.activeTurnId = result.turn.id;
        this.currentStatus = { state: "busy", activeThreadId: threadId, activeTurnId: this.activeTurnId };
      }
      return await turnCompletion;
    } catch (error) {
      this.currentStatus = { state: "idle", activeThreadId: this.activeThreadId || threadId };
      this.resetActiveTurnState();
      throw error;
    }
  }

  async steerTurn(threadId: string, turnId: string, text: string, images: CodexInputImage[] = [], files: CodexInputFile[] = []): Promise<string> {
    if (this.currentStatus.state !== "busy") {
      throw new Error("codex is not running a steerable turn");
    }
    await this.request<{ turnId: string }>("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: buildTurnInput(text, images, files)
    });
    return "Steered active Codex turn.";
  }

  async stop(): Promise<string> {
    if (!this.activeThreadId || !this.activeTurnId) {
      return "No active Codex turn.";
    }
    await this.request("turn/interrupt", {
      threadId: this.activeThreadId,
      turnId: this.activeTurnId
    });
    return "Stop requested.";
  }

  async approvePending(): Promise<string> {
    return this.resolvePendingApproval(true);
  }

  async denyPending(): Promise<string> {
    return this.resolvePendingApproval(false);
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.activeWaiter) {
      this.finishTurn(new Error(CodexAppServerClient.INTENTIONAL_SHUTDOWN_MESSAGE));
    }
    this.child?.kill("SIGTERM");
  }

  private async request<T>(method: string, params?: unknown): Promise<T> {
    await this.start();
    if (!this.rpc) throw new Error("Codex app-server is not connected");
    return await this.rpc.request<T>(method, params);
  }

  private handleNotification(method: string, params: unknown): void {
    const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
    this.noteTurnActivity();
    if (method === "item/agentMessage/delta" && typeof record.delta === "string") {
      this.activeReply += record.delta;
      void Promise.resolve(this.activeDeltaHandler?.(record.delta)).catch(() => {});
      return;
    }
    if (method === "turn/completed") {
      const reply = this.activeReply.trim() || CODEX_NO_TEXT_OUTPUT_MESSAGE;
      this.finishTurn(reply);
      return;
    }
    if (method === "item/completed") {
      const imageOutput = extractImageOutput(record);
      if (imageOutput) {
        if (this.activeImageOutputHandler) {
          const imageHandler = this.activeImageOutputHandler;
          const deltaHandler = this.activeDeltaHandler;
          this.activeOutputChain = this.activeOutputChain
            .then(() => Promise.resolve(imageHandler(imageOutput)))
            .catch(() => Promise.resolve(deltaHandler?.(`\n\n${imageOutput.fallbackText}`)).then(() => undefined));
        } else {
          this.activeReply += `\n\n${imageOutput.fallbackText}`;
          void Promise.resolve(this.activeDeltaHandler?.(`\n\n${imageOutput.fallbackText}`)).catch(() => {});
        }
      }
      return;
    }
    if (method === "turn/failed" || method === "turn/aborted" || method === "turn/cancelled") {
      this.finishTurn(new Error(`${method}: ${JSON.stringify(record)}`));
      return;
    }
    if (method.includes("approval")) {
      this.currentStatus = { state: "awaiting_approval", activeThreadId: this.activeThreadId, activeTurnId: this.activeTurnId };
    }
  }

  notifyTaskError(message: string, code?: string): void {
    const details = code ? `${message} (${code})` : message;
    this.finishTurn(new Error(details));
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    if (!isApprovalRequest(method)) {
      this.rpc?.respond(id, { error: `Unsupported server request: ${method}` });
      return;
    }
    this.noteTurnActivity();
    const request = formatApprovalRequest(method, params);
    this.pendingApproval = { id, method, params, request };
    this.currentStatus = { state: "awaiting_approval", activeThreadId: this.activeThreadId, activeTurnId: this.activeTurnId };
    void Promise.resolve(this.activeApprovalHandler?.(request)).catch(() => {});
  }

  private resolvePendingApproval(accept: boolean): string {
    if (!this.pendingApproval || !this.rpc) return "No pending Codex approval.";
    const pending = this.pendingApproval;
    this.pendingApproval = null;
    this.rpc.respond(pending.id, approvalResponse(pending.method, pending.params, accept));
    this.currentStatus = { state: "busy", activeThreadId: this.activeThreadId, activeTurnId: this.activeTurnId };
    this.noteTurnActivity();
    return accept ? "Approved pending Codex request." : "Denied pending Codex request.";
  }

  private finishTurn(result: string | Error): void {
    this.currentStatus = result instanceof Error
      ? { state: "idle", activeThreadId: this.activeThreadId || undefined }
      : { state: "idle", activeThreadId: this.activeThreadId };
    const { resolve, reject, outputChain, deltaHandler, fileOutputHandler, workspaceSnapshot } = this.releaseActiveTurnState();
    if (result instanceof Error) {
      reject?.(result);
    } else {
      void (async () => {
        let finalReply = result;
        try {
          const outputs = await collectGeneratedFileOutputs(this.options.cwd, workspaceSnapshot);
          await outputChain.catch(() => undefined);
          await deliverGeneratedFileOutputs(outputs, fileOutputHandler, deltaHandler);
          finalReply = appendGeneratedOutputsToReply(result, outputs, fileOutputHandler, deltaHandler);
        } catch {
          finalReply = result;
        } finally {
          if (this.activeThreadId) this.refreshDesktopThread(this.activeThreadId);
          resolve?.(finalReply);
        }
      })();
    }
  }

  private releaseActiveTurnState(): ReleasedTurnState {
    const state = {
      resolve: this.activeWaiter,
      reject: this.activeRejecter,
      outputChain: this.activeOutputChain,
      deltaHandler: this.activeDeltaHandler,
      fileOutputHandler: this.activeFileOutputHandler,
      workspaceSnapshot: this.activeWorkspaceSnapshot
    };
    this.resetActiveTurnState();
    return state;
  }

  private resetActiveTurnState(): void {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }
    this.activeTurnId = "";
    this.activeWaiter = null;
    this.activeRejecter = null;
    this.activeDeltaHandler = null;
    this.activeApprovalHandler = null;
    this.activeImageOutputHandler = null;
    this.activeFileOutputHandler = null;
    this.activeOutputChain = Promise.resolve();
    this.activeWorkspaceSnapshot = new Map();
    this.pendingApproval = null;
  }

  private armTurnIdleTimer(): void {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
    }
    this.activeTimer = setTimeout(() => {
      this.finishTurn(new Error(`Codex turn timed out after ${this.turnIdleTimeoutMs()}ms of inactivity.`));
    }, this.turnIdleTimeoutMs());
  }

  private noteTurnActivity(): void {
    if (!this.activeWaiter) return;
    if (this.currentStatus.state !== "busy" && this.currentStatus.state !== "awaiting_approval") return;
    this.armTurnIdleTimer();
  }

  private turnIdleTimeoutMs(): number {
    return this.options.turnIdleTimeoutMs ?? 24 * 60 * 60_000;
  }

  private refreshDesktopThread(threadId: string): void {
    if (this.options.desktopRefresh === false) return;
    const child = spawn("/usr/bin/open", ["-b", "com.openai.codex", `codex://threads/${threadId}`], {
      stdio: "ignore",
      detached: true
    });
    child.unref();
  }
}

export async function waitForProcessExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  await once(child, "exit");
}

export function buildThreadStartParams(cwd: string): Record<string, unknown> {
  return {
    cwd,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
    serviceName: "codex-wechat-bridge",
    experimentalRawEvents: false,
    persistExtendedHistory: true
  };
}

export function buildThreadResumeParams(cwd: string, threadId: string): Record<string, unknown> {
  return {
    threadId,
    cwd,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
    persistExtendedHistory: true
  };
}

export function buildTurnInput(text: string, images: CodexInputImage[] = [], files: CodexInputFile[] = []): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [{ type: "text", text: appendFileContext(text, files), text_elements: [] }];
  for (const image of images) {
    if (image.path) {
      input.push({ type: "localImage", path: image.path });
    } else if (image.url) {
      input.push({ type: "image", url: image.url });
    }
  }
  return input;
}

function appendFileContext(text: string, files: CodexInputFile[]): string {
  if (files.length === 0) return text;
  const header = text.trim();
  const lines = files.map((file, index) => {
    const parts = [file.path];
    if (file.originalName?.trim()) {
      parts.push(`原始文件名: ${file.originalName.trim()}`);
    }
    return `${index + 1}. ${parts.join(" | ")}`;
  });
  return [
    ...(header ? [header, ""] : []),
    "附带文件（请直接读取本地路径）:",
    ...lines
  ].join("\n");
}

export function extractImageOutputText(params: unknown): string {
  return extractImageOutput(params)?.fallbackText ?? "";
}

export function extractImageOutput(params: unknown): CodexImageOutput | null {
  const item = objectRecord(objectRecord(params).item);
  if (item.type !== "imageGeneration") return null;
  const lines: string[] = [];
  const output: Omit<CodexImageOutput, "fallbackText"> = {};
  if (typeof item.result === "string" && /^https?:\/\//i.test(item.result)) {
    output.url = item.result;
    lines.push(`图片 URL: ${item.result}`);
  }
  if (typeof item.savedPath === "string" && item.savedPath.trim()) {
    output.path = item.savedPath;
    lines.push(`图片已保存: ${item.savedPath}`);
  }
  if (lines.length === 0) return null;
  return { ...output, fallbackText: lines.join("\n") };
}

type WorkspaceArtifactSnapshot = Map<string, WorkspaceArtifactMeta>;
type WorkspaceArtifactMeta = {
  mtimeMs: number;
  size: number;
};

export const detectGeneratedFileOutputs = {
  snapshot: snapshotWorkspaceArtifacts,
  collect: collectGeneratedFileOutputs
};

type PendingApproval = {
  id: number | string;
  method: string;
  params: unknown;
  request: CodexApprovalRequest;
};

type ReleasedTurnState = {
  resolve: ((text: string) => void) | null;
  reject: ((error: Error) => void) | null;
  outputChain: Promise<void>;
  deltaHandler: CodexTurnOptions["onDelta"] | null;
  fileOutputHandler: CodexTurnOptions["onFileOutput"] | null;
  workspaceSnapshot: WorkspaceArtifactSnapshot;
};

function defaultCodexCommand(): string {
  const bundled = "/Applications/Codex.app/Contents/Resources/codex";
  return existsSync(bundled) ? bundled : "codex";
}

function titleFromPreview(preview: string): string {
  return preview
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 36);
}

function shortThreadId(threadId: string): string {
  return threadId.length <= 8 ? threadId : threadId.slice(0, 8);
}

function isApprovalRequest(method: string): boolean {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "execCommandApproval",
    "applyPatchApproval"
  ].includes(method);
}

function approvalResponse(method: string, params: unknown, accept: boolean): unknown {
  if (method === "item/permissions/requestApproval") {
    const record = objectRecord(params);
    return {
      permissions: accept ? record.permissions ?? {} : {},
      scope: "session",
      strictAutoReview: false
    };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: accept ? "approved" : "denied" };
  }
  return { decision: accept ? "accept" : "decline" };
}

export function formatApprovalRequest(method: string, params: unknown): CodexApprovalRequest {
  const record = objectRecord(params);
  const command = commandText(record);
  const cwd = typeof record.cwd === "string" ? record.cwd : "";
  const reason = typeof record.reason === "string" ? record.reason : "";
  const permissions = permissionText(record);
  const title = method.includes("command") || method === "execCommandApproval"
    ? "Codex 请求执行命令"
    : method.includes("permissions")
      ? "Codex 请求扩大权限"
      : "Codex 请求修改文件";
  const lines = [
    title,
    command ? `命令: ${truncate(command, 600)}` : "",
    cwd ? `目录: ${cwd}` : "",
    reason ? `原因: ${reason}` : "",
    permissions ? `权限: ${truncate(permissions, 600)}` : "",
    "回复 1 同意，2 拒绝；也可以用 /approve 或 /deny。"
  ].filter(Boolean);
  return { summary: lines.join("\n"), method, command, cwd, reason };
}

function commandText(record: Record<string, unknown>): string {
  if (typeof record.command === "string") return record.command;
  if (Array.isArray(record.command)) return record.command.map(String).join(" ");
  return "";
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function permissionText(record: Record<string, unknown>): string {
  const permissions = record.additionalPermissions ?? record.permissions;
  if (!permissions) return "";
  return JSON.stringify(permissions);
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

const GENERATED_FILE_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".html",
  ".md",
  ".pdf",
  ".ppt",
  ".pptx",
  ".tsv",
  ".txt",
  ".xls",
  ".xlsx",
  ".zip"
]);
const IGNORED_OUTPUT_DIRS = new Set([".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules"]);
const MAX_GENERATED_FILE_BYTES = 20 * 1024 * 1024;
const MAX_GENERATED_FILE_OUTPUTS = 5;

async function deliverGeneratedFileOutputs(
  outputs: CodexFileOutput[],
  onFileOutput: CodexTurnOptions["onFileOutput"] | null,
  onDelta: CodexTurnOptions["onDelta"] | null
): Promise<void> {
  for (const output of outputs) {
    if (onFileOutput) {
      try {
        await onFileOutput(output);
        continue;
      } catch {}
    }
    await onDelta?.(`\n\n${output.fallbackText}`);
  }
}

function appendGeneratedOutputsToReply(
  reply: string,
  outputs: CodexFileOutput[],
  onFileOutput: CodexTurnOptions["onFileOutput"] | null,
  onDelta: CodexTurnOptions["onDelta"] | null
): string {
  if (outputs.length === 0 || onFileOutput || onDelta) return reply;
  const suffix = outputs.map((output) => output.fallbackText).join("\n");
  return reply.trim() ? `${reply}\n\n${suffix}` : suffix;
}

async function snapshotWorkspaceArtifacts(cwd: string): Promise<WorkspaceArtifactSnapshot> {
  const files = new Map<string, WorkspaceArtifactMeta>();
  const pending = [cwd];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_OUTPUT_DIRS.has(entry.name)) {
          pending.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile() || !GENERATED_FILE_EXTENSIONS.has(extname(fullPath).toLowerCase())) continue;
      try {
        const info = await stat(fullPath);
        if (info.size <= 0 || info.size > MAX_GENERATED_FILE_BYTES) continue;
        files.set(fullPath, { mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        continue;
      }
    }
  }
  return files;
}

async function collectGeneratedFileOutputs(cwd: string, before: WorkspaceArtifactSnapshot): Promise<CodexFileOutput[]> {
  const after = await snapshotWorkspaceArtifacts(cwd);
  return Array.from(after.entries())
    .filter(([path]) => !before.has(path))
    .sort((left, right) => left[1].mtimeMs - right[1].mtimeMs || left[0].localeCompare(right[0]))
    .slice(0, MAX_GENERATED_FILE_OUTPUTS)
    .map(([path]) => ({
      path,
      fallbackText: `文件已生成: ${path}`
    }));
}

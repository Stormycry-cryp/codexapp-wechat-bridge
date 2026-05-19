#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { BridgeStore } from "./storage.js";
import { defaultConfig, defaultDataDir, loadAccount, loadConfig, saveAccount, saveConfig } from "./config.js";
import { IlinkApiClient } from "./wechat/ilink-api.js";
import { CodexAppServerClient } from "./codex/app-server-client.js";
import { SessionRouter } from "./session-router.js";
import { Logger } from "./logger.js";
import { WechatBridgeRunner } from "./wechat/transport.js";
import { ProjectRegistry, formatProjectLine } from "./projects.js";
import { acquireProcessLock } from "./process-lock.js";
import { refreshProjectThreadIndex } from "./refresh.js";

type CliOptions = {
  dataDir: string;
  cwd: string;
  apiUrl?: string;
  timeoutMs: number;
  owner?: string;
};

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  const store = new BridgeStore(options.dataDir);

  if (command === "setup") {
    await setup(store, options);
    return;
  }
  if (command === "run") {
    await run(store, options);
    return;
  }
  if (command === "status") {
    await status(store, options);
    return;
  }
  if (command === "project") {
    await projectCommand(store, options, rest);
    return;
  }
  if (command === "refresh") {
    await refreshCommand(store, options);
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function setup(store: BridgeStore, options: CliOptions): Promise<void> {
  const config = {
    ...defaultConfig(options.cwd),
    ...(await loadConfig(store, options.cwd)),
    dataDir: options.dataDir,
    workspace: options.cwd,
    ilinkBaseUrl: options.apiUrl || (await loadConfig(store, options.cwd)).ilinkBaseUrl,
    ownerUserId: options.owner || (await loadConfig(store, options.cwd)).ownerUserId
  };
  await saveConfig(store, config);

  const api = new IlinkApiClient({ baseUrl: config.ilinkBaseUrl });
  const qr = await api.getBotQrCode();
  console.log("Open this QR URL with WeChat or scan it from another screen:");
  console.log(qr.qrcode_img_content);
  console.log("");
  console.log(`QR key: ${qr.qrcode}`);
  console.log("Waiting for confirmation...");

  const started = Date.now();
  while (Date.now() - started < options.timeoutMs) {
    const result = await api.getQrCodeStatus(qr.qrcode);
    if (result.status === "confirmed" && result.bot_token) {
      await saveAccount(store, {
        token: result.bot_token,
        baseUrl: result.baseurl || config.ilinkBaseUrl,
        ilinkBotId: result.ilink_bot_id,
        ilinkUserId: result.ilink_user_id
      });
      if (!config.ownerUserId && result.ilink_user_id) {
        config.ownerUserId = result.ilink_user_id;
        await saveConfig(store, config);
      }
      console.log("WeChat iLink account configured.");
      console.log(`Data dir: ${options.dataDir}`);
      return;
    }
    process.stdout.write(".");
    await delay(3000);
  }
  throw new Error("Timed out waiting for WeChat confirmation.");
}

async function run(store: BridgeStore, options: CliOptions): Promise<void> {
  const lock = await acquireProcessLock(options.dataDir);
  const config = {
    ...(await loadConfig(store, options.cwd)),
    dataDir: options.dataDir,
    workspace: options.cwd
  };
  const account = await loadAccount(store);
  if (!account?.token) {
    throw new Error("Missing account token. Run `codex-wechat-bridge setup` first.");
  }
  const logger = new Logger(options.dataDir);
  const router = new SessionRouter(new CodexAppServerClient({ cwd: config.workspace }), store, {
    workspace: config.workspace,
    projectDiscovery: config.projectDiscovery,
    codexFactory: (project) => new CodexAppServerClient({ cwd: project.path })
  });
  const runner = new WechatBridgeRunner({ config, account, store, router, logger });
  process.once("SIGINT", () => {
    runner.stop();
    router.shutdown();
  });
  process.once("SIGTERM", () => {
    runner.stop();
    router.shutdown();
  });
  try {
    await runner.runForever();
  } finally {
    await lock.release();
  }
}

async function status(store: BridgeStore, options: CliOptions): Promise<void> {
  const config = await loadConfig(store, options.cwd);
  const account = await loadAccount(store);
  console.log(JSON.stringify({
    dataDir: options.dataDir,
    workspace: config.workspace,
    ilinkBaseUrl: config.ilinkBaseUrl,
    projectDiscovery: config.projectDiscovery,
    ownerUserId: config.ownerUserId || account?.ilinkUserId || "",
    hasWechatToken: Boolean(account?.token)
  }, null, 2));
}

async function projectCommand(store: BridgeStore, options: CliOptions, args: string[]): Promise<void> {
  const config = await loadConfig(store, options.cwd);
  const registry = new ProjectRegistry(store, config.workspace, config.projectDiscovery);
  const positionals = positionalArgs(args);
  const [subcommand = "list", key, projectPath] = positionals;
  if (subcommand === "list") {
    const projects = await registry.list();
    const state = await store.readJson<{ activeProjectKey?: string }>("bridge-state.json", {});
    const defaultProject = registry.defaultProject();
    const activeProject = projects.find((project) => project.key === state.activeProjectKey)
      ?? projects.find((project) => project.path === defaultProject.path)
      ?? projects[0];
    console.log([
      `Current project: ${activeProject.key}`,
      ...projects.map((project, index) => formatProjectLine(index, project, project.key === activeProject.key))
    ].join("\n"));
    return;
  }
  if (subcommand === "add") {
    if (!key || !projectPath) {
      throw new Error("Usage: codex-wechat-bridge project add <key> <path> [--data-dir DIR]");
    }
    await registry.add(key, projectPath);
    console.log(`Project saved: ${key}`);
    console.log(`Path: ${projectPath}`);
    return;
  }
  throw new Error(`Unknown project command: ${subcommand}`);
}

async function refreshCommand(store: BridgeStore, options: CliOptions): Promise<void> {
  const config = await loadConfig(store, options.cwd);
  const result = await refreshProjectThreadIndex({
    store,
    workspace: config.workspace
  });
  console.log([
    "Codex project/thread index refreshed.",
    `Projects: ${result.projectCount}`,
    `Thread mappings: ${result.mappedThreadCount}`,
    `Active project: ${result.activeProjectKey || "(none)"}`,
    result.backupStamp ? `Backup stamp: ${result.backupStamp}` : ""
  ].filter(Boolean).join("\n"));
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    dataDir: process.env.CODEX_WECHAT_BRIDGE_DATA_DIR || defaultDataDir(),
    cwd: process.cwd(),
    timeoutMs: 8 * 60_000
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--data-dir" && next) {
      options.dataDir = next;
      index += 1;
    } else if ((arg === "--cwd" || arg === "-C") && next) {
      options.cwd = next;
      index += 1;
    } else if (arg === "--api-url" && next) {
      options.apiUrl = next;
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      index += 1;
    } else if (arg === "--owner" && next) {
      options.owner = next;
      index += 1;
    }
  }
  return options;
}

function positionalArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--data-dir", "--cwd", "-C", "--api-url", "--timeout-ms", "--owner"].includes(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    result.push(arg);
  }
  return result;
}

function printHelp(): void {
  console.log(`codex-wechat-bridge

Usage:
  codex-wechat-bridge setup [--data-dir DIR] [--cwd DIR] [--api-url URL] [--owner USER_ID]
  codex-wechat-bridge run [--data-dir DIR] [--cwd DIR]
  codex-wechat-bridge status [--data-dir DIR] [--cwd DIR]
  codex-wechat-bridge refresh [--data-dir DIR] [--cwd DIR]
  codex-wechat-bridge project list [--data-dir DIR] [--cwd DIR]
  codex-wechat-bridge project add <key> <path> [--data-dir DIR]
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

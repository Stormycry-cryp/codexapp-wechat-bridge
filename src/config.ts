import { homedir } from "node:os";
import { resolve } from "node:path";
import { BridgeStore } from "./storage.js";

export type ProjectDiscoveryConfig = {
  codexHistory?: boolean;
  codexSessionsDir?: string;
  codexDesktopGlobalStatePath?: string;
  discoveryRoots?: string[];
  discoveryMaxDepth?: number;
};

export type BridgeConfig = {
  dataDir: string;
  workspace: string;
  ilinkBaseUrl: string;
  longPollTimeoutMs: number;
  projectDiscovery: ProjectDiscoveryConfig;
  ownerUserId?: string;
  routeTag?: string;
};

export type WechatAccount = {
  token: string;
  baseUrl?: string;
  ilinkBotId?: string;
  ilinkUserId?: string;
};

export function defaultDataDir(): string {
  return resolve(homedir(), ".codex-wechat-bridge");
}

export function defaultConfig(workspace = process.cwd()): BridgeConfig {
  return {
    dataDir: defaultDataDir(),
    workspace: resolve(workspace),
    ilinkBaseUrl: "https://ilinkai.weixin.qq.com",
    longPollTimeoutMs: 35000,
    projectDiscovery: {
      codexHistory: true,
      discoveryRoots: [],
      discoveryMaxDepth: 3
    }
  };
}

export async function loadConfig(store: BridgeStore, workspace = process.cwd()): Promise<BridgeConfig> {
  const defaults = defaultConfig(workspace);
  const stored = await store.readJson<Partial<BridgeConfig>>("config.json", {});
  return {
    ...defaults,
    ...stored,
    projectDiscovery: normalizeProjectDiscovery({
      ...defaults.projectDiscovery,
      ...(stored.projectDiscovery ?? {})
    })
  };
}

export async function saveConfig(store: BridgeStore, config: BridgeConfig): Promise<void> {
  await store.writeJson("config.json", {
    ...config,
    workspace: resolve(config.workspace),
    projectDiscovery: normalizeProjectDiscovery(config.projectDiscovery)
  });
}

export async function loadAccount(store: BridgeStore): Promise<WechatAccount | null> {
  return await store.readJson<WechatAccount | null>("account.json", null);
}

export async function saveAccount(store: BridgeStore, account: WechatAccount): Promise<void> {
  await store.writeJson("account.json", account);
}

function normalizeProjectDiscovery(config: ProjectDiscoveryConfig | undefined): ProjectDiscoveryConfig {
  return {
    codexHistory: config?.codexHistory ?? true,
    codexSessionsDir: config?.codexSessionsDir ? resolve(config.codexSessionsDir) : undefined,
    codexDesktopGlobalStatePath: config?.codexDesktopGlobalStatePath
      ? resolve(config.codexDesktopGlobalStatePath)
      : undefined,
    discoveryRoots: (config?.discoveryRoots ?? []).map((root) => resolve(root)),
    discoveryMaxDepth: Math.max(1, config?.discoveryMaxDepth ?? 3)
  };
}

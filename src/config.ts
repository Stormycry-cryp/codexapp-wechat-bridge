import { homedir } from "node:os";
import { resolve } from "node:path";
import { BridgeStore } from "./storage.js";

export type BridgeConfig = {
  dataDir: string;
  workspace: string;
  ilinkBaseUrl: string;
  longPollTimeoutMs: number;
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
    longPollTimeoutMs: 35000
  };
}

export async function loadConfig(store: BridgeStore, workspace = process.cwd()): Promise<BridgeConfig> {
  return {
    ...defaultConfig(workspace),
    ...(await store.readJson<Partial<BridgeConfig>>("config.json", {}))
  };
}

export async function saveConfig(store: BridgeStore, config: BridgeConfig): Promise<void> {
  await store.writeJson("config.json", config);
}

export async function loadAccount(store: BridgeStore): Promise<WechatAccount | null> {
  return await store.readJson<WechatAccount | null>("account.json", null);
}

export async function saveAccount(store: BridgeStore, account: WechatAccount): Promise<void> {
  await store.writeJson("account.json", account);
}


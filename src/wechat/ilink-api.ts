import { createHash, randomBytes } from "node:crypto";
import { CHANNEL_VERSION } from "../version.js";
import type { GetUpdatesResponse, IlinkMessageItem, WechatCdnRef } from "./types.js";
import {
  aesEcbPaddedSize,
  decryptWechatCdnPayload,
  encodeWechatApiAesKey,
  encryptWechatCdnPayload
} from "./media.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type IlinkApiClientOptions = {
  baseUrl?: string;
  cdnBaseUrl?: string;
  token?: string;
  routeTag?: string;
  fetchImpl?: FetchLike;
};

export class IlinkApiClient {
  private readonly baseUrl: string;
  private readonly cdnBaseUrl: string;
  private readonly token: string;
  private readonly routeTag: string;
  private readonly fetchImpl: FetchLike;
  private readonly wechatUin: string;

  constructor(options: IlinkApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl || "https://ilinkai.weixin.qq.com").replace(/\/+$/, "");
    this.cdnBaseUrl = (options.cdnBaseUrl || "https://novac2c.cdn.weixin.qq.com/c2c").replace(/\/+$/, "");
    this.token = options.token?.trim() ?? "";
    this.routeTag = options.routeTag?.trim() ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.wechatUin = randomWechatUin();
  }

  async getBotQrCode(botType = "3"): Promise<{ qrcode: string; qrcode_img_content: string }> {
    const url = new URL(`${this.baseUrl}/ilink/bot/get_bot_qrcode`);
    url.searchParams.set("bot_type", botType);
    return this.fetchJson(url.toString(), { method: "GET" });
  }

  async getQrCodeStatus(qrcode: string): Promise<{
    status: string;
    bot_token?: string;
    ilink_bot_id?: string;
    baseurl?: string;
    ilink_user_id?: string;
  }> {
    const url = new URL(`${this.baseUrl}/ilink/bot/get_qrcode_status`);
    url.searchParams.set("qrcode", qrcode);
    return this.fetchJson(url.toString(), {
      method: "GET",
      headers: { "iLink-App-ClientVersion": "1" }
    });
  }

  async getUpdates(cursor = "", timeoutMs = 35000): Promise<GetUpdatesResponse> {
    return this.postJson<GetUpdatesResponse>("ilink/bot/getupdates", {
      get_updates_buf: cursor,
      base_info: { channel_version: CHANNEL_VERSION },
      longpolling_timeout_ms: timeoutMs
    }, timeoutMs + 5000);
  }

  async sendText(toUserId: string, text: string, contextToken: string, clientId: string): Promise<void> {
    const itemList: IlinkMessageItem[] = [{ type: 1, text_item: { text } }];
    await this.sendMessageItems(toUserId, itemList, contextToken, clientId);
  }

  async sendImage(toUserId: string, bytes: Buffer, contextToken: string, clientId: string): Promise<void> {
    if (bytes.length === 0) {
      throw new Error("cannot send empty image");
    }
    const upload = await this.uploadMedia(bytes, toUserId, 1);
    await this.sendMessageItems(toUserId, [{
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: upload.downloadParam,
          aes_key: encodeWechatApiAesKey(upload.aesKey),
          encrypt_type: 1
        },
        mid_size: upload.encryptedSize
      }
    }], contextToken, clientId);
  }

  async sendFile(toUserId: string, fileName: string, bytes: Buffer, contextToken: string, clientId: string): Promise<void> {
    if (bytes.length === 0) {
      throw new Error("cannot send empty file");
    }
    const upload = await this.uploadMedia(bytes, toUserId, 3);
    await this.sendMessageItems(toUserId, [{
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: upload.downloadParam,
          aes_key: encodeWechatApiAesKey(upload.aesKey),
          encrypt_type: 1
        },
        file_name: fileName,
        md5: upload.rawMd5,
        len: String(bytes.length)
      }
    }], contextToken, clientId);
  }

  async downloadCdnMedia(ref: WechatCdnRef, timeoutMs = 120000): Promise<Buffer> {
    const url = new URL(`${this.cdnBaseUrl}/download`);
    url.searchParams.set("encrypted_query_param", ref.encryptedQueryParam);
    const encrypted = await this.fetchBytes(url.toString(), timeoutMs);
    if (ref.aesKey || ref.aesKeyHex) {
      return decryptWechatCdnPayload(encrypted, ref);
    }
    return encrypted;
  }

  private async postJson<T>(endpoint: string, body: unknown, timeoutMs = 15000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchJson<T>(`${this.baseUrl}/${endpoint.replace(/^\/+/, "")}`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendMessageItems(toUserId: string, itemList: IlinkMessageItem[], contextToken: string, clientId: string): Promise<void> {
    const response = await this.postJson<{ ret?: number; errcode?: number; errmsg?: string }>("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: itemList,
        context_token: contextToken
      },
      base_info: { channel_version: CHANNEL_VERSION }
    });
    if (response.ret != null && response.ret !== 0) {
      throw new Error(`iLink sendmessage failed: ret=${response.ret} errcode=${response.errcode ?? 0} errmsg=${response.errmsg ?? ""}`);
    }
  }

  private async uploadMedia(bytes: Buffer, toUserId: string, mediaType: number): Promise<{ downloadParam: string; aesKey: Buffer; encryptedSize: number; rawMd5: string }> {
    const filekey = randomBytes(16).toString("hex");
    const aesKey = randomBytes(16);
    const encryptedSize = aesEcbPaddedSize(bytes.length);
    const rawMd5 = createHash("md5").update(bytes).digest("hex");
    const upload = await this.postJson<{ upload_param?: string; upload_full_url?: string }>("ilink/bot/getuploadurl", {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: bytes.length,
      rawfilemd5: rawMd5,
      filesize: encryptedSize,
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
      base_info: { channel_version: CHANNEL_VERSION }
    });
    const uploadUrl = upload.upload_full_url?.trim() || this.buildCdnUploadUrl(upload.upload_param?.trim() ?? "", filekey);
    const downloadParam = await this.uploadCdnBytes(uploadUrl, encryptWechatCdnPayload(bytes, aesKey));
    return { downloadParam, aesKey, encryptedSize, rawMd5 };
  }

  private buildCdnUploadUrl(uploadParam: string, filekey: string): string {
    if (!uploadParam) {
      throw new Error("iLink getuploadurl returned no upload URL");
    }
    const url = new URL(`${this.cdnBaseUrl}/upload`);
    url.searchParams.set("encrypted_query_param", uploadParam);
    url.searchParams.set("filekey", filekey);
    return url.toString();
  }

  private async uploadCdnBytes(url: string, encrypted: Buffer, timeoutMs = 120000): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength) as ArrayBuffer,
        signal: controller.signal
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`iLink CDN upload HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      const downloadParam = response.headers.get("x-encrypted-param")?.trim();
      if (!downloadParam) {
        throw new Error("iLink CDN upload response missing x-encrypted-param");
      }
      return downloadParam;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: this.headers(init.headers)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`iLink HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) as T : {} as T;
  }

  private async fetchBytes(url: string, timeoutMs: number): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        signal: controller.signal
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`iLink CDN HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(extra?: HeadersInit): Record<string, string> {
    const headers: Record<string, string> = {};
    if (extra instanceof Headers) {
      extra.forEach((value, key) => { headers[key] = value; });
    } else if (Array.isArray(extra)) {
      for (const [key, value] of extra) headers[key] = value;
    } else if (extra) {
      Object.assign(headers, extra);
    }
    headers.AuthorizationType = "ilink_bot_token";
    headers["X-WECHAT-UIN"] = this.wechatUin;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.routeTag) headers.SKRouteTag = this.routeTag;
    return headers;
  }
}

function randomWechatUin(): string {
  return Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString("base64");
}

import { createCipheriv, createDecipheriv } from "node:crypto";
import type { WechatCdnRef } from "./types.js";

export function encryptWechatCdnPayload(payload: Buffer, aesKey: Buffer): Buffer {
  if (aesKey.length !== 16) {
    throw new Error(`iLink CDN AES key must be 16 bytes, got ${aesKey.length}`);
  }
  const cipher = createCipheriv("aes-128-ecb", aesKey, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(payload), cipher.final()]);
}

export function decryptWechatCdnPayload(payload: Buffer, ref: WechatCdnRef): Buffer {
  const key = decodeAesKey(ref);
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

export function aesEcbPaddedSize(plaintextLength: number): number {
  if (plaintextLength < 0) return 0;
  return Math.floor((plaintextLength + 16) / 16) * 16;
}

export function encodeWechatApiAesKey(key: Buffer): string {
  if (key.length !== 16) {
    throw new Error(`iLink sendmessage AES key must be 16 bytes, got ${key.length}`);
  }
  return Buffer.from(key.toString("hex")).toString("base64");
}

export function decodeAesKey(ref: WechatCdnRef): Buffer {
  if (ref.aesKeyHex?.trim()) {
    const raw = Buffer.from(ref.aesKeyHex.trim(), "hex");
    if (raw.length === 16) return raw;
  }

  if (!ref.aesKey?.trim()) {
    throw new Error("missing iLink CDN aes_key");
  }
  const decoded = Buffer.from(ref.aesKey.trim(), "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("utf8"))) {
    return Buffer.from(decoded.toString("utf8"), "hex");
  }
  throw new Error(`unsupported iLink CDN aes_key length: ${decoded.length}`);
}

export function detectImageMime(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "image/jpeg";
}

export function imageExtensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".jpg";
  }
}

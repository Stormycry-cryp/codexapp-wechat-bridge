import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { IlinkApiClient } from "../src/wechat/ilink-api.js";
import {
  aesEcbPaddedSize,
  decryptWechatCdnPayload,
  detectImageMime,
  encodeWechatApiAesKey,
  encryptWechatCdnPayload,
  imageExtensionForMime
} from "../src/wechat/media.js";

describe("wechat media helpers", () => {
  it("downloads and decrypts iLink CDN image media", async () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const png = Buffer.from("\x89PNG\r\n\x1a\nimage-data");
    const encrypted = encryptAesEcb(png, key);
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://cdn.example/c2c/download?encrypted_query_param=enc-param");
      return new Response(encrypted);
    });
    const client = new IlinkApiClient({
      baseUrl: "https://ilink.example",
      cdnBaseUrl: "https://cdn.example/c2c",
      fetchImpl
    });

    await expect(client.downloadCdnMedia({
      encryptedQueryParam: "enc-param",
      aesKeyHex: "00112233445566778899aabbccddeeff"
    })).resolves.toEqual(png);
  });

  it("detects common image mime types and extensions", () => {
    expect(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(imageExtensionForMime("image/png")).toBe(".png");
    expect(imageExtensionForMime("image/webp")).toBe(".webp");
  });

  it("decrypts base64 wrapped hex keys from iLink messages", () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const aesKey = Buffer.from(key.toString("hex")).toString("base64");
    const body = Buffer.from("hello image");
    const encrypted = encryptAesEcb(body, key);

    expect(decryptWechatCdnPayload(encrypted, { encryptedQueryParam: "enc", aesKey })).toEqual(body);
  });

  it("encrypts outbound CDN payloads and formats AES keys for sendmessage", () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const body = Buffer.from("outbound image");
    const encrypted = encryptWechatCdnPayload(body, key);

    expect(aesEcbPaddedSize(body.length)).toBe(encrypted.length);
    expect(decryptWechatCdnPayload(encrypted, { encryptedQueryParam: "enc", aesKeyHex: key.toString("hex") })).toEqual(body);
    expect(encodeWechatApiAesKey(key)).toBe(Buffer.from(key.toString("hex")).toString("base64"));
  });
});

function encryptAesEcb(body: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(body), cipher.final()]);
}

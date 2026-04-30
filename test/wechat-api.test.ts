import { describe, expect, it, vi } from "vitest";
import { IlinkApiClient } from "../src/wechat/ilink-api.js";

describe("IlinkApiClient", () => {
  it("sends getUpdates with bearer token and persisted cursor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "next" })));
    const client = new IlinkApiClient({
      baseUrl: "https://ilink.example",
      token: "secret-token",
      fetchImpl
    });

    await expect(client.getUpdates("cursor", 35000)).resolves.toEqual({
      ret: 0,
      msgs: [],
      get_updates_buf: "next"
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://ilink.example/ilink/bot/getupdates");
    expect(init.headers.Authorization).toBe("Bearer secret-token");
    expect(JSON.parse(init.body).get_updates_buf).toBe("cursor");
  });

  it("uses a stable WeChat UIN header for every request from the same client", async () => {
    const uins: string[] = [];
    const clientIds: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      uins.push(String(init?.headers?.["X-WECHAT-UIN"]));
      if (url === "https://ilink.example/ilink/bot/sendmessage") {
        const body = JSON.parse(String(init?.body));
        clientIds.push(body.msg.client_id);
      }
      return new Response(JSON.stringify({ ret: 0, msgs: [] }));
    });
    const client = new IlinkApiClient({
      baseUrl: "https://ilink.example",
      token: "secret-token",
      fetchImpl
    });

    await client.getUpdates("cursor", 10);
    await client.sendText("user@im.wechat", "one", "ctx", "client-one");
    await client.sendText("user@im.wechat", "two", "ctx", "client-two");

    expect(new Set(uins).size).toBe(1);
    expect(clientIds).toEqual(["client-one", "client-two"]);
  });

  it("uploads and sends native WeChat image messages", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://ilink.example/ilink/bot/getuploadurl") {
        const body = JSON.parse(String(init?.body));
        expect(body.media_type).toBe(1);
        expect(body.to_user_id).toBe("user@im.wechat");
        expect(body.rawsize).toBe(12);
        expect(body.filesize).toBe(16);
        expect(body.rawfilemd5).toMatch(/^[0-9a-f]{32}$/);
        expect(body.aeskey).toMatch(/^[0-9a-f]{32}$/);
        return new Response(JSON.stringify({ upload_param: "upload-param" }));
      }
      if (url.startsWith("https://cdn.example/c2c/upload?encrypted_query_param=upload-param&filekey=")) {
        const encrypted = Buffer.from(await new Response(init?.body).arrayBuffer());
        expect(encrypted.length).toBe(16);
        return new Response("", { headers: { "x-encrypted-param": "download-param" } });
      }
      if (url === "https://ilink.example/ilink/bot/sendmessage") {
        const body = JSON.parse(String(init?.body));
        expect(body.msg.to_user_id).toBe("user@im.wechat");
        expect(body.msg.context_token).toBe("ctx");
        expect(body.msg.item_list[0]).toMatchObject({
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: "download-param",
              encrypt_type: 1
            },
            mid_size: 16
          }
        });
        expect(body.msg.item_list[0].image_item.media.aes_key).toMatch(/^[A-Za-z0-9+/]+=*$/);
        return new Response(JSON.stringify({ ret: 0 }));
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new IlinkApiClient({
      baseUrl: "https://ilink.example",
      cdnBaseUrl: "https://cdn.example/c2c",
      token: "secret-token",
      fetchImpl
    });

    await expect(client.sendImage("user@im.wechat", Buffer.from("fake-png-123"), "ctx", "client-image")).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("uploads and sends native WeChat file messages", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://ilink.example/ilink/bot/getuploadurl") {
        const body = JSON.parse(String(init?.body));
        expect(body.media_type).toBe(3);
        expect(body.to_user_id).toBe("user@im.wechat");
        expect(body.rawsize).toBe(16);
        expect(body.filesize).toBe(32);
        expect(body.rawfilemd5).toMatch(/^[0-9a-f]{32}$/);
        expect(body.aeskey).toMatch(/^[0-9a-f]{32}$/);
        return new Response(JSON.stringify({ upload_param: "upload-file-param" }));
      }
      if (url.startsWith("https://cdn.example/c2c/upload?encrypted_query_param=upload-file-param&filekey=")) {
        const encrypted = Buffer.from(await new Response(init?.body).arrayBuffer());
        expect(encrypted.length).toBe(32);
        return new Response("", { headers: { "x-encrypted-param": "download-file-param" } });
      }
      if (url === "https://ilink.example/ilink/bot/sendmessage") {
        const body = JSON.parse(String(init?.body));
        expect(body.msg.to_user_id).toBe("user@im.wechat");
        expect(body.msg.context_token).toBe("ctx");
        expect(body.msg.item_list[0]).toMatchObject({
          type: 4,
          file_item: {
            file_name: "report.pdf",
            md5: expect.stringMatching(/^[0-9a-f]{32}$/),
            len: "16",
            media: {
              encrypt_query_param: "download-file-param",
              encrypt_type: 1
            }
          }
        });
        expect(body.msg.item_list[0].file_item.media.aes_key).toMatch(/^[A-Za-z0-9+/]+=*$/);
        return new Response(JSON.stringify({ ret: 0 }));
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new IlinkApiClient({
      baseUrl: "https://ilink.example",
      cdnBaseUrl: "https://cdn.example/c2c",
      token: "secret-token",
      fetchImpl
    });

    await expect(client.sendFile("user@im.wechat", "report.pdf", Buffer.from("report-body-1234"), "ctx", "client-file")).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

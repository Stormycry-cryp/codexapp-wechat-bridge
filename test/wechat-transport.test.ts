import { describe, expect, it } from "vitest";
import { parseTextFromItems, toInboundWechatMessage } from "../src/wechat/message.js";

describe("wechat message parser", () => {
  it("extracts plain text and quoted text from ilink item_list", () => {
    const items = [
      { type: 1, text_item: { text: "hello" } },
      { type: 1, ref_msg: { title: "quote", message_item: { type: 1, text_item: { text: "world" } } } }
    ];

    expect(parseTextFromItems(items)).toBe("hello\n> quote\nworld");
  });

  it("normalizes user messages and ignores bot messages", () => {
    expect(
      toInboundWechatMessage({
        message_id: 42,
        message_type: 1,
        from_user_id: "user@im.wechat",
        context_token: "ctx",
        item_list: [{ type: 1, text_item: { text: "/status" } }]
      })
    ).toEqual({
      id: "42",
      userId: "user@im.wechat",
      content: "/status",
      contextToken: "ctx"
    });

    expect(toInboundWechatMessage({ message_type: 2, from_user_id: "bot", item_list: [] })).toBeNull();
  });

  it("keeps image media references even when the message has no text", () => {
    expect(
      toInboundWechatMessage({
        message_id: 43,
        message_type: 1,
        from_user_id: "user@im.wechat",
        context_token: "ctx",
        item_list: [{
          type: 2,
          image_item: {
            aeskey: "00112233445566778899aabbccddeeff",
            media: {
              encrypt_query_param: "enc-param",
              aes_key: "base64-key",
              encrypt_type: 1
            }
          }
        }]
      })
    ).toEqual({
      id: "43",
      userId: "user@im.wechat",
      content: "",
      contextToken: "ctx",
      images: [{
        encryptedQueryParam: "enc-param",
        aesKey: "base64-key",
        aesKeyHex: "00112233445566778899aabbccddeeff"
      }]
    });
  });

  it("keeps file media references even when the message has no text", () => {
    expect(
      toInboundWechatMessage({
        message_id: 44,
        message_type: 1,
        from_user_id: "user@im.wechat",
        context_token: "ctx",
        item_list: [{
          type: 4,
          file_item: {
            file_name: "spec.pdf",
            md5: "abc123",
            len: "12",
            media: {
              encrypt_query_param: "file-param",
              aes_key: "base64-key",
              encrypt_type: 1
            }
          }
        }]
      })
    ).toEqual({
      id: "44",
      userId: "user@im.wechat",
      content: "",
      contextToken: "ctx",
      files: [{
        encryptedQueryParam: "file-param",
        aesKey: "base64-key",
        fileName: "spec.pdf",
        md5: "abc123",
        length: 12
      }]
    });
  });
});

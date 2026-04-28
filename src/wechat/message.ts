import type { IlinkMessage, IlinkMessageItem, InboundWechatMessage } from "./types.js";

const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;
const ITEM_TYPE_TEXT = 1;
const ITEM_TYPE_IMAGE = 2;

export function parseTextFromItems(items: IlinkMessageItem[] = []): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === ITEM_TYPE_TEXT && item.text_item?.text?.trim()) {
      parts.push(item.text_item.text.trim());
    }

    const refText = item.ref_msg?.message_item ? parseTextFromItems([item.ref_msg.message_item]) : "";
    if (item.ref_msg && (item.ref_msg.title?.trim() || refText.trim())) {
      const title = item.ref_msg.title?.trim();
      parts.push([title ? `> ${title}` : "", refText.trim()].filter(Boolean).join("\n"));
    }
  }
  return parts.filter(Boolean).join("\n").trim();
}

export function parseImagesFromItems(items: IlinkMessageItem[] = []) {
  return items.flatMap((item) => {
    if (item.type !== ITEM_TYPE_IMAGE) return [];
    const media = item.image_item?.media;
    const encryptedQueryParam = media?.encrypt_query_param?.trim();
    if (!encryptedQueryParam) return [];
    return [{
      encryptedQueryParam,
      aesKey: media?.aes_key?.trim() || undefined,
      aesKeyHex: item.image_item?.aeskey?.trim() || undefined
    }];
  });
}

export function toInboundWechatMessage(message: IlinkMessage): InboundWechatMessage | null {
  if (message.message_type === MESSAGE_TYPE_BOT) {
    return null;
  }
  if (message.message_type != null && message.message_type !== MESSAGE_TYPE_USER) {
    return null;
  }

  const userId = message.from_user_id?.trim();
  if (!userId) {
    return null;
  }

  const content = parseTextFromItems(message.item_list ?? []);
  const images = parseImagesFromItems(message.item_list ?? []);
  if (!content && images.length === 0) {
    return null;
  }

  return {
    id: String(message.message_id || message.client_id || `${Date.now()}`),
    userId,
    content,
    contextToken: message.context_token?.trim() ?? "",
    ...(images.length > 0 ? { images } : {})
  };
}

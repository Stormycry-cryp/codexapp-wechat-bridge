import type { IlinkCdnMedia, IlinkMessage, IlinkMessageItem, InboundWechatMessage, WechatCdnRef, WechatFileRef } from "./types.js";

const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;
const ITEM_TYPE_TEXT = 1;
const ITEM_TYPE_IMAGE = 2;
const ITEM_TYPE_FILE = 4;

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
    const ref = parseCdnRef(item.image_item?.media, item.image_item?.aeskey);
    return ref ? [ref] : [];
  });
}

export function parseFilesFromItems(items: IlinkMessageItem[] = []) {
  return items.flatMap((item) => {
    if (item.type !== ITEM_TYPE_FILE) return [];
    const ref = parseCdnRef(item.file_item?.media, item.file_item?.aeskey);
    if (!ref) return [];
    return [{
      ...ref,
      fileName: item.file_item?.file_name?.trim() || undefined,
      md5: item.file_item?.md5?.trim() || undefined,
      length: parseLength(item.file_item?.len)
    } satisfies WechatFileRef];
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
  const files = parseFilesFromItems(message.item_list ?? []);
  if (!content && images.length === 0 && files.length === 0) {
    return null;
  }

  return {
    id: String(message.message_id || message.client_id || `${Date.now()}`),
    userId,
    content,
    contextToken: message.context_token?.trim() ?? "",
    ...(images.length > 0 ? { images } : {}),
    ...(files.length > 0 ? { files } : {})
  };
}

function parseLength(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function parseCdnRef(media: IlinkCdnMedia | undefined, aesKeyHex: string | undefined): WechatCdnRef | null {
  const encryptedQueryParam = media?.encrypt_query_param?.trim();
  if (!encryptedQueryParam) return null;
  return {
    encryptedQueryParam,
    aesKey: media?.aes_key?.trim() || undefined,
    aesKeyHex: aesKeyHex?.trim() || undefined
  };
}

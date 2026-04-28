export type IlinkTextItem = {
  text?: string;
};

export type IlinkCdnMedia = {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
};

export type IlinkImageItem = {
  media?: IlinkCdnMedia;
  thumb_media?: IlinkCdnMedia;
  aeskey?: string;
  mid_size?: number;
};

export type IlinkRefMessage = {
  title?: string;
  message_item?: IlinkMessageItem;
};

export type IlinkMessageItem = {
  type?: number;
  text_item?: IlinkTextItem;
  image_item?: IlinkImageItem;
  ref_msg?: IlinkRefMessage;
};

export type WechatImageRef = {
  encryptedQueryParam: string;
  aesKey?: string;
  aesKeyHex?: string;
};

export type IlinkMessage = {
  seq?: number;
  message_id?: number | string;
  client_id?: string;
  create_time_ms?: number;
  message_type?: number;
  from_user_id?: string;
  to_user_id?: string;
  context_token?: string;
  item_list?: IlinkMessageItem[];
};

export type InboundWechatMessage = {
  id: string;
  userId: string;
  content: string;
  contextToken: string;
  images?: WechatImageRef[];
};

export type GetUpdatesResponse = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: IlinkMessage[];
  get_updates_buf?: string;
};

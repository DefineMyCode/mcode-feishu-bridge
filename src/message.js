import fs from "node:fs";
import path from "node:path";

export function renderMentions(content, mentions = []) {
  let text = String(content ?? "");
  for (const mention of mentions) {
    if (!mention || !mention.key) continue;
    const replacement = mention.name ? `@${mention.name}` : "";
    text = text.split(mention.key).join(replacement);
  }
  return text.trim();
}

export function normalizeSenderId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const idx = raw.indexOf(":");
  return idx > 0 ? raw.slice(idx + 1).trim() : raw;
}

export const TEXT_MESSAGE_TYPES = ["text", "post"];
export const MEDIA_MESSAGE_TYPES = ["image", "file", "audio", "media"];

export function normalizeEvent(raw) {
  if (!raw || raw.type !== "im.message.receive_v1") return null;
  const chatId = raw.chat_id;
  const messageId = raw.message_id || raw.id;
  if (!chatId || !messageId) return null;
  if (raw.sender_type && raw.sender_type !== "user") return null;

  const messageType = String(raw.message_type || "text").toLowerCase();
  if (!TEXT_MESSAGE_TYPES.includes(messageType) && !MEDIA_MESSAGE_TYPES.includes(messageType)) {
    return null;
  }

  const mentions = Array.isArray(raw.mentions) ? raw.mentions : [];
  const text = renderMentions(raw.content, mentions);
  if (!text && !MEDIA_MESSAGE_TYPES.includes(messageType)) return null;

  return {
    chatId,
    chatType: raw.chat_type || "p2p",
    messageId,
    messageType,
    mediaType: MEDIA_MESSAGE_TYPES.includes(messageType) ? messageType : "",
    text,
    mentions,
    senderId: normalizeSenderId(raw.sender_id || raw.sender_open_id || ""),
    threadId: raw.thread_id || "",
    rootId: raw.root_id || "",
    createTime: raw.create_time || raw.timestamp || "",
  };
}

export function isAddressedToBot(message, { botName = "", requireMention = true } = {}) {
  if (message.chatType === "p2p") return true;
  if (!requireMention) return true;
  const mentions = message.mentions || [];
  if (mentions.length === 0) return false;
  if (!botName) return true;
  return mentions.some((m) => m && typeof m.name === "string" && m.name.includes(botName));
}

export const COMMANDS = ["/help", "/new", "/stop", "/status"];

export function parseCommand(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  const [head] = trimmed.split(/\s+/, 1);
  const command = head.toLowerCase();
  if (!COMMANDS.includes(command)) return null;
  return { command, args: trimmed.slice(head.length).trim() };
}

export class Deduper {
  constructor(options = 500, { now = () => Date.now(), store } = {}) {
    const opts = typeof options === "number" ? { max: options } : options || {};
    this.limit = Math.max(1, Number(opts.max) || 500);
    this.ttlMs = Math.max(0, Number(opts.ttlMs) || 0);
    this.file = opts.file || "";
    this.logger = opts.logger;
    this.now = now;
    this.store = store || null;
    this.entries = new Map();
  }

  load() {
    if (this.store) return this;
    if (!this.file) return this;
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const data = JSON.parse(raw);
      const entries = Array.isArray(data) ? data : Object.entries(data || {});
      const list = Array.isArray(data) ? data : entries.map(([key, at]) => [key, at]);
      for (const item of list) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const [key, at] = item;
        if (typeof key !== "string" || !key) continue;
        if (this.isExpired(Number(at))) continue;
        this.entries.set(key, Number(at));
      }
      this.prune();
    } catch (err) {
      if (err.code !== "ENOENT") this.logger?.warn?.(`去重文件无法解析，按空状态启动: ${this.file}`);
    }
    return this;
  }

  save() {
    if (this.store || !this.file) return;
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data = [...this.entries.entries()];
    fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
    fs.renameSync(tmp, this.file);
  }

  isExpired(at) {
    if (!this.ttlMs) return false;
    return this.now() - at > this.ttlMs;
  }

  prune() {
    for (const [key, at] of this.entries) {
      if (this.isExpired(at)) this.entries.delete(key);
    }
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  check(key) {
    if (!key) return true;
    if (this.store) {
      if (this.store.hasSeen(key, { ttlMs: this.ttlMs, now: this.now() })) return false;
      this.store.markSeen(key, this.now());
      this.store.pruneDedup({ ttlMs: this.ttlMs, max: this.limit, now: this.now() });
      return true;
    }
    const at = this.entries.get(key);
    if (at !== undefined) {
      if (this.isExpired(at)) {
        this.entries.delete(key);
      } else {
        return false;
      }
    }
    this.entries.set(key, this.now());
    this.prune();
    return true;
  }
}
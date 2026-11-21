import fs from "node:fs";
import path from "node:path";

export function buildSessionKey({ chatId, senderId = "", chatType = "p2p", perUser = true } = {}) {
  if (!chatId) return "";
  if (chatType === "p2p" || !perUser || !senderId) return chatId;
  return `${chatId}:${senderId}`;
}

export class SessionStore {
  constructor(file, { logger, store } = {}) {
    this.file = file;
    this.logger = logger;
    this.store = store || null;
    this.map = new Map();
  }

  load() {
    if (this.store) return this;
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const data = JSON.parse(raw);
      for (const [key, sessionId] of Object.entries(data)) {
        if (typeof sessionId === "string" && sessionId) this.map.set(key, sessionId);
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        this.logger?.warn(`会话状态文件无法解析，按空状态启动: ${this.file}`);
      }
    }
    return this;
  }

  get(key) {
    if (this.store) return this.store.getSession(key);
    return this.map.get(key) || "";
  }

  getWithFallback(key, legacyKey = "") {
    if (this.store) return this.store.getSession(key, legacyKey);
    const value = this.get(key);
    if (value) return value;
    if (!legacyKey || legacyKey === key) return "";
    return this.get(legacyKey);
  }

  set(key, sessionId) {
    if (!key || !sessionId) return;
    if (this.store) {
      this.store.setSession(key, sessionId);
      return;
    }
    this.map.set(key, sessionId);
  }

  clear(key) {
    if (this.store) return this.store.clearSession(key) > 0;
    return this.map.delete(key);
  }

  size() {
    if (this.store) return this.store.countSessions();
    return this.map.size;
  }

  save() {
    if (this.store) return;
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data = Object.fromEntries(this.map.entries());
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }
}
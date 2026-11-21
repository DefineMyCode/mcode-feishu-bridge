import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 2;

const TASK_STATES = ["queued", "running", "succeeded", "failed", "stopped", "interrupted"];
const FINAL_STATES = ["succeeded", "failed", "stopped", "interrupted"];

export function createTaskId(now = Date.now()) {
  return `task_${now}_${randomBytes(4).toString("hex")}`;
}

export class TaskStore {
  constructor(file, { logger } = {}) {
    if (!file) throw new Error("TASK_DB 未配置");
    if (!path.isAbsolute(file)) throw new Error(`TASK_DB 必须是绝对路径: ${file}`);
    this.file = file;
    this.logger = logger;
    this.db = null;
  }

  open() {
    if (this.db) return this;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    return this;
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  get opened() {
    return Boolean(this.db);
  }

  transaction(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dedup (
        message_id TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dedup_seen ON dedup(seen_at);
    `);

    if (!this.tableExists("tasks")) {
      this.createTasksTable();
      this.setSchemaVersion(SCHEMA_VERSION);
      return;
    }

    if (this.getSchemaVersion() < 2) {
      this.rebuildTasksTable();
    }
  }

  tableExists(name) {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
    return Boolean(row);
  }

  setSchemaVersion(version) {
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)")
      .run(String(version));
  }

  createTasksTable() {
    this.db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        media_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','stopped','interrupted')),
        attempts INTEGER NOT NULL DEFAULT 0,
        progress_message_id TEXT,
        result_summary TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_key, status);
    `);
  }

  rebuildTasksTable() {
    this.transaction(() => {
      this.db.exec(`
        DROP INDEX IF EXISTS idx_tasks_status_created;
        DROP INDEX IF EXISTS idx_tasks_session;
        ALTER TABLE tasks RENAME TO tasks_v1;
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          prompt TEXT NOT NULL,
          media_json TEXT,
          status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','stopped','interrupted')),
          attempts INTEGER NOT NULL DEFAULT 0,
          progress_message_id TEXT,
          result_summary TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER
        );
        INSERT INTO tasks (id, session_key, chat_id, message_id, prompt, media_json, status, attempts, progress_message_id, result_summary, error, created_at, started_at, finished_at)
          SELECT id, session_key, chat_id, message_id, prompt, media_json, status, attempts, progress_message_id, result_summary, error, created_at, started_at, finished_at FROM tasks_v1;
        DROP TABLE tasks_v1;
        CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_key, status);
      `);
      this.setSchemaVersion(SCHEMA_VERSION);
    });
    this.logger?.info?.("任务表已升级到 schema 2，新增 stopped 终态");
  }

  getSchemaVersion() {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return Number(row?.value || 0);
  }

  getMeta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row?.value ?? "";
  }

  setMeta(key, value) {
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)")
      .run(key, String(value));
  }

  createTask({
    id = createTaskId(),
    sessionKey,
    chatId,
    messageId,
    prompt,
    media = [],
    now = Date.now(),
  }) {
    this.db
      .prepare(
        `INSERT INTO tasks(id, session_key, chat_id, message_id, prompt, media_json, status, attempts, created_at)
         VALUES(?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
      )
      .run(id, sessionKey, chatId, messageId, prompt, JSON.stringify(media || []), now);
    return id;
  }

  getTask(id) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? this.mapTask(row) : null;
  }

  mapTask(row) {
    return {
      id: row.id,
      sessionKey: row.session_key,
      chatId: row.chat_id,
      messageId: row.message_id,
      prompt: row.prompt,
      media: safeParse(row.media_json),
      status: row.status,
      attempts: Number(row.attempts),
      progressMessageId: row.progress_message_id || "",
      resultSummary: row.result_summary || "",
      error: row.error || "",
      createdAt: Number(row.created_at),
      startedAt: row.started_at ? Number(row.started_at) : 0,
      finishedAt: row.finished_at ? Number(row.finished_at) : 0,
    };
  }

  markRunning(id, now = Date.now()) {
    return this.db
      .prepare(
        `UPDATE tasks SET status = 'running', started_at = ?, attempts = attempts + 1
         WHERE id = ? AND status IN ('queued','interrupted')`,
      )
      .run(now, id).changes;
  }

  markSucceeded(id, { summary = "", now = Date.now() } = {}) {
    return this.db
      .prepare(
        `UPDATE tasks SET status = 'succeeded', result_summary = ?, error = NULL, finished_at = ?
         WHERE id = ?`,
      )
      .run(summary, now, id).changes;
  }

  markFailed(id, { error = "", now = Date.now() } = {}) {
    return this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
      )
      .run(error, now, id).changes;
  }

  markInterrupted(id, { error = "进程重启中断", now = Date.now() } = {}) {
    return this.db
      .prepare(
        `UPDATE tasks SET status = 'interrupted', error = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
      )
      .run(error, now, id).changes;
  }

  markStopped(id, { reason = "用户主动停止", now = Date.now() } = {}) {
    return this.db
      .prepare(
        `UPDATE tasks SET status = 'stopped', error = ?, finished_at = ? WHERE id = ? AND status IN ('queued','running')`,
      )
      .run(reason, now, id).changes;
  }

  setProgressMessageId(id, progressMessageId) {
    return this.db
      .prepare("UPDATE tasks SET progress_message_id = ? WHERE id = ?")
      .run(progressMessageId, id).changes;
  }

  updatePrompt(id, prompt) {
    return this.db.prepare("UPDATE tasks SET prompt = ? WHERE id = ?").run(prompt, id).changes;
  }

  listByStatus(status) {
    const allowed = TASK_STATES.includes(status);
    if (!allowed) throw new Error(`未知任务状态: ${status}`);
    return this.db
      .prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC")
      .all(status)
      .map((row) => this.mapTask(row));
  }

  markRunningAsInterrupted({ error = "进程重启中断", now = Date.now() } = {}) {
    return this.db
      .prepare(
        `UPDATE tasks SET status = 'interrupted', error = ?, finished_at = ? WHERE status = 'running'`,
      )
      .run(error, now).changes;
  }

  requeue(id) {
    return this.db
      .prepare("UPDATE tasks SET status = 'queued' WHERE id = ? AND status = 'interrupted'")
      .run(id).changes;
  }

  countByStatus() {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status")
      .all();
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.c)]));
  }

  cleanupTasks({ retentionMs = 0, now = Date.now() } = {}) {
    if (!retentionMs) return 0;
    const cutoff = now - retentionMs;
    const placeholders = FINAL_STATES.map(() => "?").join(",");
    return Number(
      this.db
        .prepare(
          `DELETE FROM tasks WHERE status IN (${placeholders}) AND finished_at IS NOT NULL AND finished_at < ?`,
        )
        .run(...FINAL_STATES, cutoff).changes,
    );
  }

  getSession(sessionKey, legacyKey = "") {
    const row = this.db
      .prepare("SELECT session_id FROM sessions WHERE session_key = ?")
      .get(sessionKey);
    if (row?.session_id) return row.session_id;
    if (!legacyKey || legacyKey === sessionKey) return "";
    const legacy = this.db
      .prepare("SELECT session_id FROM sessions WHERE session_key = ?")
      .get(legacyKey);
    return legacy?.session_id || "";
  }

  setSession(sessionKey, sessionId, now = Date.now()) {
    if (!sessionKey || !sessionId) return;
    this.db
      .prepare(
        `INSERT INTO sessions(session_key, session_id, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
      )
      .run(sessionKey, sessionId, now);
  }

  clearSession(sessionKey) {
    return this.db.prepare("DELETE FROM sessions WHERE session_key = ?").run(sessionKey).changes;
  }

  countSessions() {
    return Number(this.db.prepare("SELECT COUNT(*) AS c FROM sessions").get().c);
  }

  clearAllSessions() {
    return Number(this.db.prepare("DELETE FROM sessions").run().changes);
  }

  hasSeen(messageId, { ttlMs = 0, now = Date.now() } = {}) {
    if (!messageId) return false;
    const row = this.db.prepare("SELECT seen_at FROM dedup WHERE message_id = ?").get(messageId);
    if (!row) return false;
    if (ttlMs > 0 && now - Number(row.seen_at) > ttlMs) {
      this.db.prepare("DELETE FROM dedup WHERE message_id = ?").run(messageId);
      return false;
    }
    return true;
  }

  markSeen(messageId, now = Date.now()) {
    if (!messageId) return;
    this.db
      .prepare(
        `INSERT INTO dedup(message_id, seen_at) VALUES(?, ?)
         ON CONFLICT(message_id) DO UPDATE SET seen_at = excluded.seen_at`,
      )
      .run(messageId, now);
  }

  pruneDedup({ ttlMs = 0, max = 2048, now = Date.now() } = {}) {
    let removed = 0;
    if (ttlMs > 0) {
      removed += Number(
        this.db.prepare("DELETE FROM dedup WHERE seen_at < ?").run(now - ttlMs).changes,
      );
    }
    const count = Number(this.db.prepare("SELECT COUNT(*) AS c FROM dedup").get().c);
    if (count > max) {
      removed += Number(
        this.db
          .prepare(
            `DELETE FROM dedup WHERE message_id IN (
               SELECT message_id FROM dedup ORDER BY seen_at ASC LIMIT ?
             )`,
          )
          .run(count - max).changes,
      );
    }
    return removed;
  }

  countDedup() {
    return Number(this.db.prepare("SELECT COUNT(*) AS c FROM dedup").get().c);
  }

  importJson({ sessionsFile, dedupFile, ttlMs = 0, now = Date.now() } = {}) {
    const result = { sessions: 0, dedup: 0 };

    if (this.countSessions() === 0 && sessionsFile && fs.existsSync(sessionsFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
        const insert = this.db.prepare(
          `INSERT OR REPLACE INTO sessions(session_key, session_id, updated_at) VALUES(?, ?, ?)`,
        );
        this.transaction(() => {
          for (const [key, value] of Object.entries(data)) {
            if (typeof value === "string" && value) {
              insert.run(key, value, now);
              result.sessions += 1;
            }
          }
        });
      } catch (err) {
        this.logger?.warn?.(`迁移会话文件失败: ${sessionsFile}`);
      }
    }

    if (this.countDedup() === 0 && dedupFile && fs.existsSync(dedupFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(dedupFile, "utf8"));
        const entries = Array.isArray(data) ? data : [];
        const insert = this.db.prepare(
          `INSERT OR REPLACE INTO dedup(message_id, seen_at) VALUES(?, ?)`,
        );
        this.transaction(() => {
          for (const item of entries) {
            if (!Array.isArray(item) || item.length < 2) continue;
            const [messageId, seenAt] = item;
            if (typeof messageId !== "string" || !messageId) continue;
            if (ttlMs > 0 && now - Number(seenAt) > ttlMs) continue;
            insert.run(messageId, Number(seenAt) || now);
            result.dedup += 1;
          }
        });
      } catch (err) {
        this.logger?.warn?.(`迁移去重文件失败: ${dedupFile}`);
      }
    }

    if (result.sessions > 0 || result.dedup > 0) {
      this.db
        .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('migrated_from_json', ?)")
        .run(String(now));
    }
    return result;
  }
}

function safeParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
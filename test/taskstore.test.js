import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskStore, createTaskId } from "../src/taskstore.js";

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskstore-"));
  return new TaskStore(path.join(dir, "tasks.db")).open();
}

function seedTask(store, overrides = {}) {
  return store.createTask({
    sessionKey: "oc_1",
    chatId: "oc_1",
    messageId: "om_1",
    prompt: "跑个任务",
    now: 1000,
    ...overrides,
  });
}

test("建表并写入 schema 版本", () => {
  const store = makeStore();
  assert.equal(store.getSchemaVersion(), 2);
  assert.equal(store.opened, true);
  store.close();
  assert.equal(store.opened, false);
});

test("相对路径直接报错", () => {
  assert.throws(() => new TaskStore("data/tasks.db"), /绝对路径/);
  assert.throws(() => new TaskStore(""), /TASK_DB/);
});

test("任务从 queued 到 running 到 succeeded", () => {
  const store = makeStore();
  const id = seedTask(store);
  assert.equal(store.getTask(id).status, "queued");

  assert.equal(store.markRunning(id, 1100), 1);
  const running = store.getTask(id);
  assert.equal(running.status, "running");
  assert.equal(running.attempts, 1);
  assert.equal(running.startedAt, 1100);

  store.setProgressMessageId(id, "om_card");
  store.markSucceeded(id, { summary: "完成", now: 1200 });
  const done = store.getTask(id);
  assert.equal(done.status, "succeeded");
  assert.equal(done.resultSummary, "完成");
  assert.equal(done.progressMessageId, "om_card");
  assert.equal(done.finishedAt, 1200);
  store.close();
});

test("失败与中断分别记录原因", () => {
  const store = makeStore();
  const failed = seedTask(store, { messageId: "om_a" });
  store.markRunning(failed);
  store.markFailed(failed, { error: "超时" });
  assert.equal(store.getTask(failed).status, "failed");
  assert.equal(store.getTask(failed).error, "超时");

  const interrupted = seedTask(store, { messageId: "om_b" });
  store.markRunning(interrupted);
  store.markInterrupted(interrupted, { error: "服务停止" });
  assert.equal(store.getTask(interrupted).status, "interrupted");
  assert.equal(store.getTask(interrupted).error, "服务停止");
  store.close();
});

test("启动时把残留的 running 标记为 interrupted", () => {
  const store = makeStore();
  const a = seedTask(store, { messageId: "om_a" });
  const b = seedTask(store, { messageId: "om_b" });
  store.markRunning(a);
  store.markRunning(b);
  store.markSucceeded(seedTask(store, { messageId: "om_c" }), { summary: "done" });

  const changed = store.markRunningAsInterrupted({ now: 2000 });
  assert.equal(changed, 2);
  assert.equal(store.getTask(a).status, "interrupted");
  assert.equal(store.getTask(b).status, "interrupted");
  assert.equal(store.countByStatus().interrupted, 2);
  store.close();
});

test("中断任务可以回到队列等待重投", () => {
  const store = makeStore();
  const id = seedTask(store);
  store.markRunning(id);
  store.markInterrupted(id);
  assert.equal(store.requeue(id), 1);
  assert.equal(store.getTask(id).status, "queued");
  assert.equal(store.requeue(id), 0);
  store.close();
});

test("按状态查询按创建时间排序", () => {
  const store = makeStore();
  seedTask(store, { messageId: "om_late", now: 3000 });
  seedTask(store, { messageId: "om_early", now: 1000 });
  const queued = store.listByStatus("queued");
  assert.equal(queued.length, 2);
  assert.equal(queued[0].createdAt, 1000);
  assert.throws(() => store.listByStatus("unknown"), /未知任务状态/);
  store.close();
});

test("会话可读写、回退旧键并统计", () => {
  const store = makeStore();
  store.setSession("oc_1:ou_1", "ses_new", 1000);
  store.setSession("oc_1", "ses_legacy", 1000);
  assert.equal(store.getSession("oc_1:ou_1"), "ses_new");
  assert.equal(store.getSession("oc_1:ou_2", "oc_1"), "ses_legacy");
  assert.equal(store.getSession("oc_missing"), "");
  assert.equal(store.countSessions(), 2);
  assert.equal(store.clearSession("oc_1"), 1);
  assert.equal(store.getSession("oc_1"), "");
  store.close();
});

test("去重识别重复并支持 TTL 过期", () => {
  let now = 1000;
  const store = makeStore();
  assert.equal(store.hasSeen("om_1", { ttlMs: 500, now }), false);
  store.markSeen("om_1", now);
  assert.equal(store.hasSeen("om_1", { ttlMs: 500, now }), true);

  now = 1600;
  assert.equal(store.hasSeen("om_1", { ttlMs: 500, now }), false);
  assert.equal(store.countDedup(), 0);
  store.close();
});

test("去重按容量淘汰最旧记录", () => {
  const store = makeStore();
  store.markSeen("om_1", 1000);
  store.markSeen("om_2", 2000);
  store.markSeen("om_3", 3000);
  assert.equal(store.pruneDedup({ max: 2, ttlMs: 0, now: 3000 }), 1);
  assert.equal(store.countDedup(), 2);
  assert.equal(store.hasSeen("om_1"), false);
  assert.equal(store.hasSeen("om_3"), true);
  store.close();
});

test("按保留期清理终态任务", () => {
  const store = makeStore();
  const old = seedTask(store, { messageId: "om_old" });
  store.markRunning(old, 1000);
  store.markSucceeded(old, { summary: "ok", now: 1000 });

  const fresh = seedTask(store, { messageId: "om_new", now: 5000 });
  store.markRunning(fresh, 5000);
  store.markSucceeded(fresh, { summary: "ok", now: 5000 });

  const removed = store.cleanupTasks({ retentionMs: 1000, now: 6000 });
  assert.equal(removed, 1);
  assert.equal(store.getTask(old), null);
  assert.equal(store.getTask(fresh).status, "succeeded");
  assert.equal(store.cleanupTasks({ retentionMs: 0, now: 9000 }), 0);
  store.close();
});

test("从 JSON 迁移会话与去重且幂等", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskstore-"));
  const sessionsFile = path.join(dir, "sessions.json");
  const dedupFile = path.join(dir, "seen.json");
  fs.writeFileSync(sessionsFile, JSON.stringify({ "oc_1": "ses_1" }), "utf8");
  fs.writeFileSync(
    dedupFile,
    JSON.stringify([
      ["om_1", 1800],
      ["om_expired", 1],
    ]),
    "utf8",
  );

  const store = new TaskStore(path.join(dir, "tasks.db")).open();
  const first = store.importJson({ sessionsFile, dedupFile, ttlMs: 500, now: 2000 });
  assert.equal(first.sessions, 1);
  assert.equal(first.dedup, 1);
  assert.equal(store.getSession("oc_1"), "ses_1");
  assert.equal(store.hasSeen("om_1"), true);

  const second = store.importJson({ sessionsFile, dedupFile, ttlMs: 500, now: 3000 });
  assert.deepEqual(second, { sessions: 0, dedup: 0 });
  store.close();
});

test("迁移遇到损坏文件时只告警不抛出", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskstore-"));
  const sessionsFile = path.join(dir, "sessions.json");
  fs.writeFileSync(sessionsFile, "{broken", "utf8");
  const warnings = [];
  const store = new TaskStore(path.join(dir, "tasks.db"), {
    logger: { warn: (m) => warnings.push(m) },
  }).open();
  const result = store.importJson({ sessionsFile, now: 1000 });
  assert.equal(result.sessions, 0);
  assert.equal(warnings.length, 1);
  store.close();
});

test("任务 ID 带前缀与随机后缀", () => {
  const first = createTaskId(1000);
  const second = createTaskId(1000);
  assert.match(first, /^task_1000_[0-9a-f]{8}$/);
  assert.notEqual(first, second);
});

test("用户主动停止记为 stopped 终态", () => {
  const store = makeStore();
  const id = seedTask(store);
  store.markRunning(id);
  assert.equal(store.markStopped(id, { reason: "用户主动停止" }), 1);
  const task = store.getTask(id);
  assert.equal(task.status, "stopped");
  assert.equal(task.error, "用户主动停止");
  store.close();
});

test("v1 库升级到 v2 并保留任务数据", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskstore-v1-"));
  const file = path.join(dir, "tasks.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (session_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE dedup (message_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
    CREATE INDEX idx_dedup_seen ON dedup(seen_at);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      media_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','interrupted')),
      attempts INTEGER NOT NULL DEFAULT 0,
      progress_message_id TEXT,
      result_summary TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX idx_tasks_status_created ON tasks(status, created_at);
    CREATE INDEX idx_tasks_session ON tasks(session_key, status);
    INSERT INTO meta(key, value) VALUES('schema_version', '1');
    INSERT INTO tasks(id, session_key, chat_id, message_id, prompt, status, attempts, created_at)
      VALUES('task_v1', 'oc_1', 'oc_1', 'om_1', '旧任务', 'interrupted', 1, 1000);
  `);
  db.close();

  const store = new TaskStore(file).open();
  assert.equal(store.getSchemaVersion(), 2);
  const task = store.getTask("task_v1");
  assert.equal(task.status, "interrupted");
  assert.equal(task.prompt, "旧任务");

  const id = store.createTask({
    sessionKey: "oc_1",
    chatId: "oc_1",
    messageId: "om_2",
    prompt: "新任务",
    now: 2000,
  });
  store.markRunning(id, 2100);
  assert.equal(store.markStopped(id, { now: 2200 }), 1);
  assert.equal(store.getTask(id).status, "stopped");
  store.close();
});
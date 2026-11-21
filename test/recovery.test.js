import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/taskstore.js";
import { recoverTasks, taskToMessage } from "../src/recovery.js";

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-"));
  return new TaskStore(path.join(dir, "tasks.db")).open();
}

function seed(store, overrides = {}) {
  return store.createTask({
    sessionKey: "oc_1",
    chatId: "oc_1",
    messageId: "om_1",
    prompt: "原始任务",
    media: { chatType: "p2p", messageType: "text", text: "原始任务", mentions: [], senderId: "ou_1" },
    now: 1000,
    ...overrides,
  });
}

const baseConfig = { taskAutoRetry: true, taskMaxAttempts: 2 };

test("残留执行中任务被标记中断并重投", async () => {
  const store = makeStore();
  const id = seed(store);
  store.markRunning(id, 1100);

  const submitted = [];
  const result = await recoverTasks({
    store,
    config: baseConfig,
    submit: (task) => submitted.push(task),
    now: 2000,
  });

  assert.equal(result.interrupted, 1);
  assert.equal(result.requeued, 1);
  assert.equal(result.submitted, 1);
  assert.equal(submitted[0].id, id);
  assert.equal(store.getTask(id).status, "queued");
  assert.equal(store.getTask(id).attempts, 1);
  store.close();
});

test("达到尝试上限后不再重投", async () => {
  const store = makeStore();
  const id = seed(store);
  store.markRunning(id, 1100);
  store.markInterrupted(id, { now: 1200 });
  store.requeue(id);
  store.markRunning(id, 1300);
  assert.equal(store.getTask(id).attempts, 2);

  const submitted = [];
  const result = await recoverTasks({
    store,
    config: baseConfig,
    submit: (task) => submitted.push(task),
    now: 2000,
  });

  assert.equal(result.interrupted, 1);
  assert.equal(result.requeued, 0);
  assert.equal(result.submitted, 0);
  assert.equal(store.getTask(id).status, "interrupted");
  store.close();
});

test("关闭自动重投时只标记中断", async () => {
  const store = makeStore();
  const id = seed(store);
  store.markRunning(id, 1100);

  const submitted = [];
  const result = await recoverTasks({
    store,
    config: { taskAutoRetry: false, taskMaxAttempts: 2 },
    submit: (task) => submitted.push(task),
    now: 2000,
  });

  assert.equal(result.requeued, 0);
  assert.equal(result.submitted, 0);
  assert.equal(store.getTask(id).status, "interrupted");
  assert.equal(store.getTask(id).error, "进程重启中断");
  store.close();
});

test("已排队的任务在启动时被重新投递", async () => {
  const store = makeStore();
  const a = seed(store, { messageId: "om_a", now: 1000 });
  const b = seed(store, { messageId: "om_b", now: 2000 });

  const submitted = [];
  const result = await recoverTasks({
    store,
    config: baseConfig,
    submit: (task) => submitted.push(task),
    now: 3000,
  });

  assert.equal(result.interrupted, 0);
  assert.equal(result.submitted, 2);
  assert.deepEqual(
    submitted.map((task) => task.id),
    [a, b],
  );
  store.close();
});

test("不重投的任务会收到中断通知", async () => {
  const store = makeStore();
  const id = seed(store);
  store.markRunning(id, 1100);
  store.markInterrupted(id, { now: 1200 });

  const notified = [];
  const result = await recoverTasks({
    store,
    config: { taskAutoRetry: false, taskMaxAttempts: 2 },
    submit: () => {},
    notifyInterrupted: async (task, reason) => notified.push({ id: task.id, reason }),
    now: 2000,
  });

  assert.equal(result.kept, 1);
  assert.deepEqual(notified, [{ id, reason: "进程重启中断" }]);
  store.close();
});

test("重投的任务不会触发中断通知", async () => {
  const store = makeStore();
  const id = seed(store);
  store.markRunning(id, 1100);

  const notified = [];
  await recoverTasks({
    store,
    config: baseConfig,
    submit: () => {},
    notifyInterrupted: async (task) => notified.push(task.id),
    now: 2000,
  });

  assert.equal(notified.length, 0);
  store.close();
});

test("通知失败不影响恢复流程", async () => {
  const store = makeStore();
  const id = seed(store);
  store.markRunning(id, 1100);
  store.markInterrupted(id, { now: 1200 });

  const warnings = [];
  const result = await recoverTasks({
    store,
    config: { taskAutoRetry: false, taskMaxAttempts: 2 },
    submit: () => {},
    notifyInterrupted: async () => {
      throw new Error("飞书不可用");
    },
    logger: { warn: (m) => warnings.push(m) },
    now: 2000,
  });

  assert.equal(result.kept, 1);
  assert.equal(warnings.length, 1);
  assert.equal(store.getTask(id).status, "interrupted");
  store.close();
});

test("taskToMessage 从任务还原消息字段", () => {
  const store = makeStore();
  const id = seed(store, {
    media: {
      chatType: "group",
      messageType: "post",
      mediaType: "",
      text: "看下附件",
      mentions: [{ key: "@_user_1", name: "码道" }],
      senderId: "ou_9",
    },
  });
  const message = taskToMessage(store.getTask(id));
  assert.equal(message.chatId, "oc_1");
  assert.equal(message.chatType, "group");
  assert.equal(message.messageType, "post");
  assert.equal(message.text, "看下附件");
  assert.equal(message.senderId, "ou_9");
  assert.equal(message.mentions.length, 1);
  store.close();
});

test("主动停止的任务不会被重投", async () => {
  const store = makeStore();
  const id = seed(store);
  store.markRunning(id, 1100);
  store.markStopped(id, { reason: "用户主动停止", now: 1200 });

  const submitted = [];
  const notified = [];
  const result = await recoverTasks({
    store,
    config: baseConfig,
    submit: (task) => submitted.push(task),
    notifyInterrupted: async (task) => notified.push(task.id),
    now: 2000,
  });

  assert.equal(result.submitted, 0);
  assert.equal(result.requeued, 0);
  assert.equal(notified.length, 0);
  assert.equal(store.getTask(id).status, "stopped");
  store.close();
});
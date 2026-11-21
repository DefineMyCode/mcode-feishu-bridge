import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, buildSessionKey } from "../src/sessions.js";

test("会话状态可保存并重新加载", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sessions-")), "nested", "sessions.json");
  const store = new SessionStore(file).load();
  store.set("oc_1", "ses_1");
  store.set("oc_2", "ses_2");
  store.save();
  assert.equal(store.size(), 2);

  const reloaded = new SessionStore(file).load();
  assert.equal(reloaded.get("oc_1"), "ses_1");
  assert.equal(reloaded.get("oc_2"), "ses_2");
  assert.equal(reloaded.get("oc_missing"), "");
});

test("clear 删除映射后再保存", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sessions-")), "sessions.json");
  const store = new SessionStore(file).load();
  store.set("oc_1", "ses_1");
  store.save();
  assert.equal(store.clear("oc_1"), true);
  store.save();
  assert.equal(new SessionStore(file).load().get("oc_1"), "");
});

test("文件损坏时按空状态启动并告警", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sessions-")), "sessions.json");
  fs.writeFileSync(file, "{broken", "utf8");
  const warnings = [];
  const store = new SessionStore(file, { logger: { warn: (m) => warnings.push(m) } }).load();
  assert.equal(store.size(), 0);
  assert.equal(warnings.length, 1);
});

test("空 chatId 或 sessionId 不写入", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sessions-")), "sessions.json");
  const store = new SessionStore(file).load();
  store.set("", "ses");
  store.set("oc", "");
  assert.equal(store.size(), 0);
});

test("会话键：私聊只用 chatId", () => {
  assert.equal(
    buildSessionKey({ chatId: "oc_1", senderId: "ou_1", chatType: "p2p", perUser: true }),
    "oc_1",
  );
});

test("会话键：群聊按人隔离时拼接参与者", () => {
  assert.equal(
    buildSessionKey({ chatId: "oc_1", senderId: "ou_1", chatType: "group", perUser: true }),
    "oc_1:ou_1",
  );
});

test("会话键：关闭按人隔离时回退 chatId", () => {
  assert.equal(
    buildSessionKey({ chatId: "oc_1", senderId: "ou_1", chatType: "group", perUser: false }),
    "oc_1",
  );
  assert.equal(
    buildSessionKey({ chatId: "oc_1", senderId: "", chatType: "group", perUser: true }),
    "oc_1",
  );
  assert.equal(buildSessionKey({}), "");
});

test("取不到新键时回退旧键", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sessions-")), "sessions.json");
  const store = new SessionStore(file).load();
  store.set("oc_1", "ses_legacy");
  assert.equal(store.getWithFallback("oc_1:ou_1", "oc_1"), "ses_legacy");

  store.set("oc_1:ou_1", "ses_new");
  assert.equal(store.getWithFallback("oc_1:ou_1", "oc_1"), "ses_new");
  assert.equal(store.getWithFallback("oc_1:ou_2", "oc_1"), "ses_legacy");
  assert.equal(store.getWithFallback("oc_9", "oc_9"), "");
});
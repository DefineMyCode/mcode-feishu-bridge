import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeEvent,
  normalizeSenderId,
  renderMentions,
  isAddressedToBot,
  parseCommand,
  Deduper,
} from "../src/message.js";

function p2pEvent(overrides = {}) {
  return {
    type: "im.message.receive_v1",
    chat_id: "oc_1",
    chat_type: "p2p",
    message_id: "om_1",
    message_type: "text",
    content: "帮我看看代码",
    sender_type: "user",
    sender_id: "ou_1",
    mentions: [],
    ...overrides,
  };
}

test("渲染 @ 占位符为用户名", () => {
  const text = renderMentions("@_user_1 请执行", [{ key: "@_user_1", name: "码道" }]);
  assert.equal(text, "@码道 请执行");
});

test("缺少 mention 名字时直接移除占位符", () => {
  assert.equal(renderMentions("@_user_1 你好", [{ key: "@_user_1" }]), "你好");
});

test("归一化私聊文本消息", () => {
  const message = normalizeEvent(p2pEvent());
  assert.equal(message.chatId, "oc_1");
  assert.equal(message.messageId, "om_1");
  assert.equal(message.chatType, "p2p");
  assert.equal(message.text, "帮我看看代码");
});

test("非消息事件被忽略", () => {
  assert.equal(normalizeEvent({ type: "im.chat.updated_v1" }), null);
  assert.equal(normalizeEvent(null), null);
});

test("机器人自己发来的消息被忽略", () => {
  assert.equal(normalizeEvent(p2pEvent({ sender_type: "bot" })), null);
});

test("未支持的消息类型被忽略", () => {
  assert.equal(normalizeEvent(p2pEvent({ message_type: "sticker", content: "" })), null);
});

test("图片消息即使没有文本也会归一化", () => {
  const message = normalizeEvent(p2pEvent({ message_type: "image", content: "" }));
  assert.equal(message.mediaType, "image");
  assert.equal(message.messageType, "image");
  assert.equal(message.text, "");
});

test("文件消息标记类型并保留渲染文本", () => {
  const message = normalizeEvent(p2pEvent({ message_type: "file", content: "a.txt" }));
  assert.equal(message.mediaType, "file");
  assert.equal(message.text, "a.txt");
});

test("缺少会话或消息 ID 被忽略", () => {
  assert.equal(normalizeEvent(p2pEvent({ chat_id: "" })), null);
  assert.equal(normalizeEvent(p2pEvent({ message_id: "", id: "" })), null);
});

test("兼容旧字段 id", () => {
  const message = normalizeEvent(p2pEvent({ message_id: "", id: "om_legacy" }));
  assert.equal(message.messageId, "om_legacy");
});

test("发送者 ID 去掉身份前缀", () => {
  assert.equal(normalizeSenderId("user:ou_1"), "ou_1");
  assert.equal(normalizeSenderId("bot:cli_x"), "cli_x");
  assert.equal(normalizeSenderId("ou_1"), "ou_1");
  assert.equal(normalizeSenderId(""), "");
  const message = normalizeEvent(p2pEvent({ sender_id: "user:ou_9" }));
  assert.equal(message.senderId, "ou_9");
});

test("私聊消息总是响应", () => {
  const message = normalizeEvent(p2pEvent());
  assert.equal(isAddressedToBot(message, { requireMention: true }), true);
});

test("群聊未 @ 机器人时忽略", () => {
  const message = normalizeEvent(p2pEvent({ chat_type: "group", mentions: [] }));
  assert.equal(isAddressedToBot(message, { requireMention: true }), false);
  assert.equal(isAddressedToBot(message, { requireMention: false }), true);
});

test("群聊按机器人名称匹配 mention", () => {
  const message = normalizeEvent(
    p2pEvent({ chat_type: "group", content: "@_user_1 跑测试", mentions: [{ key: "@_user_1", name: "码道" }] }),
  );
  assert.equal(isAddressedToBot(message, { botName: "码道" }), true);
  assert.equal(isAddressedToBot(message, { botName: "其他机器人" }), false);
});

test("解析已知斜杠命令", () => {
  assert.deepEqual(parseCommand("/new"), { command: "/new", args: "" });
  assert.deepEqual(parseCommand("/status now"), { command: "/status", args: "now" });
  assert.deepEqual(parseCommand("/HELP"), { command: "/help", args: "" });
});

test("普通文本与未知斜杠命令不被识别为命令", () => {
  assert.equal(parseCommand("你好"), null);
  assert.equal(parseCommand("/unknown"), null);
});

test("去重器按容量淘汰旧键", () => {
  const deduper = new Deduper(2);
  assert.equal(deduper.check("a"), true);
  assert.equal(deduper.check("a"), false);
  assert.equal(deduper.check("b"), true);
  assert.equal(deduper.check("c"), true);
  assert.equal(deduper.check("a"), true);
});

test("空键视为新消息", () => {
  const deduper = new Deduper(2);
  assert.equal(deduper.check(""), true);
  assert.equal(deduper.check(""), true);
});

test("去重记录按 TTL 过期后可再次处理", () => {
  let now = 1000;
  const deduper = new Deduper({ max: 10, ttlMs: 500 }, { now: () => now });
  assert.equal(deduper.check("om_1"), true);
  assert.equal(deduper.check("om_1"), false);
  now += 600;
  assert.equal(deduper.check("om_1"), true);
});

test("去重记录可持久化并在重启后生效", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dedup-")), "nested", "seen.json");
  const first = new Deduper({ max: 10, ttlMs: 60000, file }).load();
  assert.equal(first.check("om_1"), true);
  first.check("om_2");
  first.save();

  const second = new Deduper({ max: 10, ttlMs: 60000, file }).load();
  assert.equal(second.check("om_1"), false);
  assert.equal(second.check("om_2"), false);
  assert.equal(second.check("om_3"), true);
});

test("损坏的去重文件按空状态启动并告警", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dedup-")), "seen.json");
  fs.writeFileSync(file, "{broken", "utf8");
  const warnings = [];
  const deduper = new Deduper({ max: 10, file, logger: { warn: (m) => warnings.push(m) } }).load();
  assert.equal(deduper.check("om_1"), true);
  assert.equal(warnings.length, 1);
});
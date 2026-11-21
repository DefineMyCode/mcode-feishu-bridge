import test from "node:test";
import assert from "node:assert/strict";
import { TextBatcher, mergeMessages } from "../src/batching.js";

function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn) {
      seq += 1;
      pending.set(seq, fn);
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fireAll() {
      for (const [id, fn] of [...pending.entries()]) {
        pending.delete(id);
        fn();
      }
    },
    size() {
      return pending.size;
    },
  };
}

function message(id, text, overrides = {}) {
  return { messageId: id, chatId: "oc_1", text, mentions: [], ...overrides };
}

test("单条消息 flush 时保持原样", () => {
  const timers = fakeTimers();
  const flushed = [];
  const batcher = new TextBatcher({ timers, onFlush: (m) => flushed.push(m) });
  batcher.add("oc_1", message("om_1", "你好"));
  timers.fireAll();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].text, "你好");
  assert.equal(flushed[0].batchedCount, undefined);
});

test("连续消息合并为一条并保留最后一条消息 ID", () => {
  const timers = fakeTimers();
  const flushed = [];
  const batcher = new TextBatcher({ timers, onFlush: (m) => flushed.push(m) });
  batcher.add("oc_1", message("om_1", "第一段"));
  batcher.add("oc_1", message("om_2", "第二段"));
  timers.fireAll();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].text, "第一段\n\n第二段");
  assert.equal(flushed[0].messageId, "om_2");
  assert.equal(flushed[0].batchedCount, 2);
});

test("不同会话互不合并", () => {
  const timers = fakeTimers();
  const flushed = [];
  const batcher = new TextBatcher({ timers, onFlush: (m) => flushed.push(m) });
  batcher.add("oc_1", message("om_1", "甲"));
  batcher.add("oc_2", message("om_2", "乙"));
  timers.fireAll();
  assert.equal(flushed.length, 2);
  assert.deepEqual(
    flushed.map((m) => m.text).sort(),
    ["乙", "甲"].sort(),
  );
});

test("超过条数上限先落盘再开新批", () => {
  const timers = fakeTimers();
  const flushed = [];
  const batcher = new TextBatcher({
    timers,
    maxMessages: 2,
    onFlush: (m) => flushed.push(m),
  });
  batcher.add("oc_1", message("om_1", "a"));
  batcher.add("oc_1", message("om_2", "b"));
  batcher.add("oc_1", message("om_3", "c"));
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].batchedCount, 2);
  timers.fireAll();
  assert.equal(flushed.length, 2);
  assert.equal(flushed[1].text, "c");
});

test("超过字符上限先落盘", () => {
  const timers = fakeTimers();
  const flushed = [];
  const batcher = new TextBatcher({
    timers,
    maxChars: 5,
    onFlush: (m) => flushed.push(m),
  });
  batcher.add("oc_1", message("om_1", "abc"));
  batcher.add("oc_1", message("om_2", "def"));
  assert.equal(flushed.length, 1);
  timers.fireAll();
  assert.equal(flushed.length, 2);
});

test("flushAll 逐会话推送并清空", () => {
  const timers = fakeTimers();
  const flushed = [];
  const batcher = new TextBatcher({ timers, onFlush: (m) => flushed.push(m) });
  batcher.add("oc_1", message("om_1", "a"));
  batcher.add("oc_2", message("om_2", "b"));
  const result = batcher.flushAll();
  assert.equal(result.length, 2);
  assert.equal(batcher.size(), 0);
  assert.equal(timers.size(), 0);
});

test("空消息列表返回 null", () => {
  assert.equal(mergeMessages([]), null);
  assert.equal(mergeMessages(null), null);
});
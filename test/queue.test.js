import test from "node:test";
import assert from "node:assert/strict";
import { TaskQueue } from "../src/queue.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("同一会话串行执行", async () => {
  const queue = new TaskQueue({ maxConcurrency: 2 });
  const order = [];
  const first = queue.push("oc_1", async () => {
    order.push("first-start");
    await sleep(30);
    order.push("first-end");
  });
  const second = queue.push("oc_1", async () => {
    order.push("second-start");
    order.push("second-end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
});

test("不同会话受全局并发限制", async () => {
  const queue = new TaskQueue({ maxConcurrency: 1 });
  const order = [];
  const a = queue.push("a", async () => {
    order.push("a-start");
    await sleep(30);
    order.push("a-end");
  });
  const b = queue.push("b", async () => {
    order.push("b-start");
  });
  assert.equal(queue.pending, 2);
  assert.equal(queue.isBusy("a"), true);
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
  assert.equal(queue.isBusy("a"), false);
});

test("任务异常不会卡住队列", async () => {
  const queue = new TaskQueue({ maxConcurrency: 1 });
  await assert.rejects(queue.push("a", async () => {
    throw new Error("boom");
  }));
  await queue.push("a", async () => "ok");
  await sleep(0);
  assert.equal(queue.isBusy("a"), false);
});
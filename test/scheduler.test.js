import test from "node:test";
import assert from "node:assert/strict";
import { parseCronTasks, cronMatches, createScheduler } from "../src/scheduler.js";
import { TaskQueue } from "../src/queue.js";

test("parseCronTasks 解析多条任务并忽略坏行", () => {
  const tasks = parseCronTasks("0 9 * * *|总结提交|oc_1; 30 18 * * 1-5|检查 CI|oc_2");
  assert.deepEqual(
    tasks.map((t) => [t.cron, t.prompt, t.chatId]),
    [
      ["0 9 * * *", "总结提交", "oc_1"],
      ["30 18 * * 1-5", "检查 CI", "oc_2"],
    ],
  );
  assert.deepEqual(parseCronTasks("0 9 * * *|只有两段"), []);
  assert.deepEqual(parseCronTasks(""), []);
});

test("cronMatches 支持通配、步长、范围与列表", () => {
  const at = (hour, minute, day = 1) => new Date(2026, 0, day, hour, minute, 0);

  assert.equal(cronMatches("0 9 * * *", at(9, 0)), true);
  assert.equal(cronMatches("0 9 * * *", at(9, 1)), false);
  assert.equal(cronMatches("*/15 * * * *", at(10, 45)), true);
  assert.equal(cronMatches("*/15 * * * *", at(10, 46)), false);
  assert.equal(cronMatches("0 9 * * 1-5", at(9, 0)), true);
  assert.equal(cronMatches("0 9 * * 0,6", at(9, 0)), false);
  assert.equal(cronMatches("not a cron", at(9, 0)), false);
});

test("createScheduler 命中后执行并投递结果", async () => {
  const queue = new TaskQueue({ maxConcurrency: 2 });
  const sent = [];
  const lark = {
    sendMarkdown: async (chatId, text) => {
      sent.push({ chatId, text });
      return { code: 0 };
    },
  };
  const fixed = new Date(2026, 0, 1, 9, 0, 0);
  const scheduler = createScheduler({
    tasks: [{ cron: "0 9 * * *", prompt: "总结", chatId: "oc_1" }],
    config: {
      mcodeBin: "mcode",
      workdir: "/tmp",
      model: "",
      effort: "",
      promptMode: "tui",
      permission: "smart",
      timeoutMs: 1000,
      maxSteps: 0,
    },
    queue,
    lark,
    runMcp: async () => ({ text: "done", sessionID: "s1" }),
    logger: { info() {}, error() {} },
    intervalMs: 10,
    now: () => fixed,
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  scheduler.stop();

  assert.equal(scheduler.running, true);
  assert.ok(sent.length >= 1, "应该至少投递一次");
  assert.equal(sent[0].chatId, "oc_1");
  assert.match(sent[0].text, /done/);
});

test("没有任务时不启动定时器", () => {
  const scheduler = createScheduler({
    tasks: [],
    config: {},
    queue: new TaskQueue({}),
    lark: {},
    runMcp: async () => ({}),
  });
  assert.equal(scheduler.running, false);
});
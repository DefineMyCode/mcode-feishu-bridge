import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMessageHandler } from "../src/handler.js";
import { SessionStore } from "../src/sessions.js";
import { TaskQueue } from "../src/queue.js";
import { Deduper, normalizeEvent } from "../src/message.js";
import { TaskStore } from "../src/taskstore.js";

function makeConfig(overrides = {}) {
  return {
    codeartsBin: "codearts",
    workdir: os.tmpdir(),
    model: "",
    agent: "",
    timeoutMs: 60000,
    replyFormat: "card",
    replyChunkSize: 1800,
    replyMaxChunks: 4,
    heartbeatMinutes: 0,
    attachLongOutput: true,
    outputDir: path.join(os.tmpdir(), "handler-output"),
    ack: true,
    allowedChatIds: [],
    allowedUserIds: [],
    groupPolicy: "open",
    groupRules: {},
    groupSessionsPerUser: true,
    reactions: true,
    reactionProcessingEmoji: "Typing",
    reactionFailureEmoji: "CrossMark",
    requireMentionInGroup: true,
    botName: "",
    ...overrides,
  };
}

function makeLark() {
  const replies = [];
  const reactions = [];
  const files = [];
  const texts = [];
  const lark = {
    replyCard: async (messageId, card) => {
      const parsed = JSON.parse(card);
      replies.push({
        messageId,
        card,
        text: parsed.elements?.[0]?.content ?? "",
        mode: "card",
      });
      return { code: 0 };
    },
    replyMarkdown: async (messageId, text) => {
      replies.push({ messageId, text, mode: "markdown" });
      return { code: 0 };
    },
    replyText: async (messageId, text) => {
      replies.push({ messageId, text, mode: "text" });
      return { code: 0 };
    },
    addReaction: async (messageId, emojiType) => {
      reactions.push({ action: "add", messageId, emojiType });
      return `rx_${messageId}`;
    },
    removeReaction: async (messageId, reactionId) => {
      reactions.push({ action: "remove", messageId, reactionId });
      return true;
    },
    sendFile: async (chatId, file) => {
      files.push({ chatId, file });
      return { code: 0 };
    },
    sendText: async (chatId, text) => {
      texts.push({ chatId, text });
      return { code: 0 };
    },
  };
  return { lark, replies, reactions, files, texts };
}

function makeHarness({ config = makeConfig(), runMcp, batcher, store } = {}) {
  const { lark, replies, reactions, files, texts } = makeLark();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "handler-")), "sessions.json");
  const sessions = new SessionStore(file).load();
  const queue = new TaskQueue({ maxConcurrency: 2 });
  const errors = [];
  const handle = createMessageHandler({
    config,
    sessions,
    queue,
    lark,
    logger: { error: (...args) => errors.push(args), warn: () => {}, debug: () => {} },
    runMcp: runMcp || (async () => ({ text: "done", sessionID: "ses_new", exitCode: 0 })),
    deduper: new Deduper(500),
    batcher,
    store,
  });
  return { handle, replies, reactions, sessions, queue, errors, store, files, texts };
}

function event(overrides = {}) {
  return {
    type: "im.message.receive_v1",
    chat_id: "oc_1",
    chat_type: "p2p",
    message_id: "om_1",
    message_type: "text",
    sender_type: "user",
    sender_id: "ou_1",
    content: "修个 bug",
    mentions: [],
    ...overrides,
  };
}

test("私聊消息先确认再回复结果并保存会话", async () => {
  const { handle, replies, sessions } = makeHarness();
  const result = await handle(event());
  assert.equal(result.status, "started");
  await result.run;

  assert.equal(replies.length, 2);
  assert.match(replies[0].text, /已收到/);
  assert.equal(replies[1].text, "done");
  assert.equal(sessions.get("oc_1"), "ses_new");
});

test("关闭确认后可只回结果", async () => {
  const { handle, replies } = makeHarness({ config: makeConfig({ ack: false }) });
  await (await handle(event())).run;
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "done");
});

test("/help 与 /status 直接回复", async () => {
  const { handle, replies } = makeHarness();
  const help = await handle(event({ message_id: "om_help", content: "/help" }));
  assert.equal(help.status, "command");
  assert.match(replies[0].text, /\/new/);

  const status = await handle(event({ message_id: "om_status", content: "/status" }));
  assert.equal(status.status, "command");
  assert.match(replies[1].text, /空闲/);
  assert.match(replies[1].text, /会话键：oc_1/);
});

test("/new 清除会话上下文", async () => {
  const { handle, sessions } = makeHarness();
  sessions.set("oc_1", "ses_old");
  await handle(event({ message_id: "om_new", content: "/new" }));
  assert.equal(sessions.get("oc_1"), "");
});

test("群聊未 @ 机器人不响应", async () => {
  const { handle, replies } = makeHarness();
  const result = await handle(event({ chat_type: "group", mentions: [] }));
  assert.equal(result.status, "not-addressed");
  assert.equal(replies.length, 0);
});

test("白名单外会话被忽略", async () => {
  const { handle, replies } = makeHarness({ config: makeConfig({ allowedChatIds: ["oc_other"] }) });
  const result = await handle(event());
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "chat-not-allowed");
  assert.equal(replies.length, 0);
});

test("重复消息只处理一次", async () => {
  const { handle, replies } = makeHarness();
  await (await handle(event())).run;
  const again = await handle(event());
  assert.equal(again.status, "duplicate");
  assert.equal(replies.length, 2);
});

test("同一会话执行中再次发言会提示", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { handle, replies } = makeHarness({
    runMcp: async () => {
      await gate;
      return { text: "done", sessionID: "ses_1" };
    },
  });

  const first = await handle(event({ message_id: "om_a" }));
  await handle(event({ message_id: "om_b" }));
  release();
  await first.run;
  assert.ok(replies.some((r) => /上一个任务还在执行/.test(r.text)));
});

test("/stop 中止正在执行的任务", async () => {
  let aborted = false;
  const { handle, replies } = makeHarness({
    runMcp: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ text: "stopped", aborted: true });
        });
      }),
  });

  const first = await handle(event({ message_id: "om_run" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await handle(event({ message_id: "om_stop", content: "/stop" }));
  await first.run;

  assert.equal(aborted, true);
  assert.ok(replies.some((r) => /已发送停止信号/.test(r.text)));
  assert.ok(replies.some((r) => /已停止当前任务/.test(r.text)));
});

test("码道启动失败时回复错误摘要", async () => {
  const { handle, replies } = makeHarness({
    runMcp: async () => ({ spawnError: "ENOENT", text: "" }),
  });
  await (await handle(event())).run;
  assert.match(replies.at(-1).text, /启动 mcode 失败/);
});

test("Markdown 回复失败时自动回退纯文本", async () => {
  const replies = [];
  const lark = {
    replyMarkdown: async (messageId, text) => {
      replies.push({ messageId, text, mode: "markdown" });
      return { code: 1, stderr: "markdown not supported" };
    },
    replyText: async (messageId, text) => {
      replies.push({ messageId, text, mode: "text" });
      return { code: 0 };
    },
  };
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "handler-")), "sessions.json");
  const handle = createMessageHandler({
    config: makeConfig(),
    sessions: new SessionStore(stateFile).load(),
    queue: new TaskQueue({ maxConcurrency: 1 }),
    lark,
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
    runMcp: async () => ({ text: "done", sessionID: "ses_fallback" }),
  });

  await (await handle(event())).run;
  assert.deepEqual(replies.map((r) => r.mode), ["markdown", "text", "markdown", "text"]);
  assert.equal(replies.at(-1).text, "done");
});

test("卡片失败时依次回退 Markdown 与纯文本", async () => {
  const replies = [];
  const lark = {
    replyCard: async (messageId, card) => {
      replies.push({ messageId, card, mode: "card" });
      return { code: 1, stderr: "card rejected" };
    },
    replyMarkdown: async (messageId, text) => {
      replies.push({ messageId, text, mode: "markdown" });
      return { code: 1, stderr: "markdown rejected" };
    },
    replyText: async (messageId, text) => {
      replies.push({ messageId, text, mode: "text" });
      return { code: 0 };
    },
  };
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "handler-")), "sessions.json");
  const handle = createMessageHandler({
    config: makeConfig({ replyFormat: "card" }),
    sessions: new SessionStore(stateFile).load(),
    queue: new TaskQueue({ maxConcurrency: 1 }),
    lark,
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
    runMcp: async () => ({ text: "done", sessionID: "ses_card" }),
  });

  await (await handle(event())).run;
  assert.deepEqual(replies.map((r) => r.mode), [
    "card",
    "markdown",
    "text",
    "card",
    "markdown",
    "text",
  ]);
  assert.equal(replies.at(-1).text, "done");
});

test("REPLY_FORMAT=text 时不尝试卡片与 Markdown", async () => {
  const modes = [];
  const lark = {
    replyCard: async () => {
      modes.push("card");
      return { code: 0 };
    },
    replyMarkdown: async () => {
      modes.push("markdown");
      return { code: 0 };
    },
    replyText: async () => {
      modes.push("text");
      return { code: 0 };
    },
  };
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "handler-")), "sessions.json");
  const handle = createMessageHandler({
    config: makeConfig({ replyFormat: "text", ack: false }),
    sessions: new SessionStore(stateFile).load(),
    queue: new TaskQueue({ maxConcurrency: 1 }),
    lark,
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
    runMcp: async () => ({ text: "done", sessionID: "ses_text" }),
  });

  await (await handle(event())).run;
  assert.deepEqual(modes, ["text"]);
});

test("群聊默认按发言人隔离会话", async () => {
  const { handle, sessions } = makeHarness({
    config: makeConfig({ requireMentionInGroup: false }),
  });

  const first = await handle(
    event({ chat_type: "group", message_id: "om_a", sender_id: "ou_a" }),
  );
  await first.run;
  const second = await handle(
    event({ chat_type: "group", message_id: "om_b", sender_id: "ou_b" }),
  );
  await second.run;

  assert.equal(sessions.get("oc_1:ou_a"), "ses_new");
  assert.equal(sessions.get("oc_1:ou_b"), "ses_new");
  assert.equal(sessions.get("oc_1"), "");
});

test("关闭按人隔离后全群共享会话", async () => {
  const { handle, sessions } = makeHarness({
    config: makeConfig({ requireMentionInGroup: false, groupSessionsPerUser: false }),
  });
  await (await handle(event({ chat_type: "group", message_id: "om_a", sender_id: "ou_a" }))).run;
  await (await handle(event({ chat_type: "group", message_id: "om_b", sender_id: "ou_b" }))).run;
  assert.equal(sessions.get("oc_1"), "ses_new");
  assert.equal(sessions.get("oc_1:ou_a"), "");
});

test("用户白名单外的人被拒绝", async () => {
  const { handle, replies } = makeHarness({
    config: makeConfig({ allowedUserIds: ["ou_ok"] }),
  });
  const result = await handle(event());
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "user-not-allowed");
  assert.equal(replies.length, 0);
});

test("群策略 disabled 时忽略整群", async () => {
  const { handle, replies } = makeHarness({
    config: makeConfig({ groupPolicy: "disabled" }),
  });
  const result = await handle(event());
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "group-disabled");
  assert.equal(replies.length, 0);
});

test("群规则可放开 @ 要求并限定名单", async () => {
  const { handle, replies } = makeHarness({
    config: makeConfig({
      groupRules: {
        oc_1: { policy: "allowlist", allowlist: ["ou_a"], requireMention: false },
      },
    }),
  });

  const allowed = await handle(event({ chat_type: "group", sender_id: "ou_a" }));
  assert.equal(allowed.status, "started");
  await allowed.run;

  const denied = await handle(
    event({ chat_type: "group", message_id: "om_2", sender_id: "ou_b" }),
  );
  assert.equal(denied.status, "blocked");
  assert.equal(denied.reason, "user-not-allowed");
  assert.ok(replies.length > 0);
});

test("任务执行前后添加并清理状态表情", async () => {
  const { handle, reactions } = makeHarness();
  await (await handle(event())).run;
  assert.deepEqual(reactions[0], { action: "add", messageId: "om_1", emojiType: "Typing" });
  assert.deepEqual(reactions.at(-1), {
    action: "remove",
    messageId: "om_1",
    reactionId: "rx_om_1",
  });
});

test("关闭表情开关后不再调用表情接口", async () => {
  const { handle, reactions } = makeHarness({ config: makeConfig({ reactions: false }) });
  await (await handle(event())).run;
  assert.equal(reactions.length, 0);
});

test("配置批处理器时消息进入批处理而不立即执行", async () => {
  const batcher = { added: [], add: (key, message) => batcher.added.push({ key, message }) };
  const { handle, replies } = makeHarness({ batcher });
  const result = await handle(event({ sender_id: "ou_a" }));
  assert.equal(result.status, "batched");
  assert.equal(replies.length, 0);
  assert.equal(batcher.added[0].key, "oc_1");
  assert.equal(batcher.added.length, 1);
});

test("批处理后的合并消息可通过 startRun 执行", async () => {
  const { handle, replies } = makeHarness({ config: makeConfig({ ack: false }) });
  const run = handle.startRun(normalizeEvent(event({ message_id: "om_merged", content: "合并后的任务" })));
  await run;
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "done");
});

function makeProgressHarness({ config = makeConfig(), runMcp, updateFails = false } = {}) {
  const events = [];
  const lark = {
    replyCard: async (messageId, card) => {
      events.push({ action: "replyCard", messageId, card: JSON.parse(card) });
      return { code: 0, stdout: JSON.stringify({ ok: true, data: { message_id: "om_bot_card" } }) };
    },
    updateCard: async (messageId, card) => {
      events.push({ action: "updateCard", messageId, card: JSON.parse(card) });
      return updateFails ? { code: 1, stderr: "patch failed" } : { code: 0 };
    },
    replyMarkdown: async (messageId, text) => {
      events.push({ action: "replyMarkdown", messageId, text });
      return { code: 0 };
    },
    replyText: async (messageId, text) => {
      events.push({ action: "replyText", messageId, text });
      return { code: 0 };
    },
  };
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "handler-")), "sessions.json");
  const handle = createMessageHandler({
    config,
    sessions: new SessionStore(stateFile).load(),
    queue: new TaskQueue({ maxConcurrency: 1 }),
    lark,
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
    runMcp: runMcp || (async () => ({ text: "done", sessionID: "ses_progress" })),
    deduper: new Deduper(500),
  });
  return { handle, events };
}

test("进度卡片模式：完成后原位更新同一条卡片", async () => {
  const { handle, events } = makeProgressHarness();
  await (await handle(event())).run;

  const cards = events.filter((e) => e.action === "replyCard");
  const updates = events.filter((e) => e.action === "updateCard");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].card.header.title.content, "任务执行中");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].messageId, "om_bot_card");
  assert.equal(updates[0].card.elements[0].content, "done");
  assert.equal(events.filter((e) => e.action === "replyMarkdown").length, 0);
});

test("进度卡片更新失败时回退为发送新消息", async () => {
  const { handle, events } = makeProgressHarness({ updateFails: true });
  await (await handle(event())).run;

  const updates = events.filter((e) => e.action === "updateCard");
  assert.equal(updates.length, 1);
  const cards = events.filter((e) => e.action === "replyCard");
  assert.equal(cards.length, 2);
  assert.equal(cards.at(-1).card.elements[0].content, "done");
});

test("关闭进度卡片后恢复确认文本与结果消息", async () => {
  const { handle, events } = makeProgressHarness({
    config: makeConfig({ progressCard: false }),
  });
  await (await handle(event())).run;

  assert.equal(events.filter((e) => e.action === "updateCard").length, 0);
  const cards = events.filter((e) => e.action === "replyCard");
  assert.equal(cards.length, 2);
  assert.match(cards[0].card.elements[0].content, /已收到/);
  assert.equal(cards[1].card.elements[0].content, "done");
});

function makeMediaHarness({ detail = null, download = null, config = makeConfig(), runMcp } = {}) {
  const prompts = [];
  const lark = {
    replyCard: async () => ({ code: 0 }),
    replyMarkdown: async () => ({ code: 0 }),
    replyText: async () => ({ code: 0 }),
    fetchMessageDetail: async () => detail,
    downloadResource: async (args) => (download ? download(args) : null),
  };
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "handler-")), "sessions.json");
  const handle = createMessageHandler({
    config,
    sessions: new SessionStore(stateFile).load(),
    queue: new TaskQueue({ maxConcurrency: 1 }),
    lark,
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
    runMcp:
      runMcp ||
      (async ({ prompt }) => {
        prompts.push(prompt);
        return { text: "done", sessionID: "ses_media" };
      }),
    deduper: new Deduper(500),
  });
  return { handle, prompts };
}

test("媒体消息下载资源后拼进提示词", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "media-")), "note.txt");
  fs.writeFileSync(file, "文件里的内容", "utf8");
  const { handle, prompts } = makeMediaHarness({
    detail: { msgType: "file", content: JSON.stringify({ file_key: "file_1", file_name: "note.txt" }) },
    download: async () => ({ localPath: file, sizeBytes: 20, type: "file" }),
  });

  await (
    await handle(event({ message_type: "file", content: "看下附件", message_id: "om_media" }))
  ).run;

  assert.match(prompts[0], /看下附件/);
  assert.match(prompts[0], /【用户附带资源】/);
  assert.match(prompts[0], /文件里的内容/);
});

test("富文本消息里的文件也会下载并注入", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "media-")), "post.txt");
  fs.writeFileSync(file, "富文本附件内容", "utf8");
  const { handle, prompts } = makeMediaHarness({
    detail: {
      msgType: "post",
      content: JSON.stringify({
        content: [[{ tag: "text", text: "看这个文件" }]],
        files: [{ file_key: "file_9", file_name: "新建 文本文档.txt" }],
      }),
    },
    download: async () => ({ localPath: file, sizeBytes: 30, type: "file" }),
  });

  await (
    await handle(event({ message_type: "post", content: "看这个文件", message_id: "om_post" }))
  ).run;

  assert.match(prompts[0], /【用户附带资源】/);
  assert.match(prompts[0], /富文本附件内容/);
});

test("资源下载为空时保留原文", async () => {
  const { handle, prompts } = makeMediaHarness({ detail: null });
  await (
    await handle(event({ message_type: "image", content: "", message_id: "om_img" }))
  ).run;
  assert.equal(prompts[0], "用户发送了附件，但桥接未能下载到本地。");
});

test("媒体消息不进入文本批处理", async () => {
  const batcher = { added: [], add: (key, message) => batcher.added.push({ key, message }) };
  const { handle } = makeHarness({ batcher });
  const result = await handle(event({ message_type: "image", content: "[Image: img_1]" }));
  assert.equal(result.status, "started");
  assert.equal(batcher.added.length, 0);
});

test("进度卡片带停止按钮，点击后终止任务", async () => {
  let aborted = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { handle, events } = makeProgressHarness({
    runMcp: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ text: "stopped", aborted: true });
        });
        gate.then(() => resolve({ text: "done", sessionID: "ses_btn" }));
      }),
  });

  const run = handle.startRun(normalizeEvent(event({ message_id: "om_btn" })));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const card = events.find((item) => item.action === "replyCard").card;
  const action = card.elements.at(-1);
  assert.equal(action.tag, "action");
  assert.deepEqual(action.actions[0].value, { cmd: "/stop", key: "oc_1" });

  const result = await handle.cardAction({
    type: "card.action.trigger",
    chat_id: "oc_1",
    action_value: JSON.stringify({ cmd: "/stop", key: "oc_1" }),
    token: "tok_1",
  });
  assert.equal(result.status, "stopped");
  assert.equal(aborted, true);
  release();
  await run;
});

test("没有对应任务时按钮回调给出提示", async () => {
  const { handle } = makeProgressHarness();
  const result = await handle.cardAction({
    type: "card.action.trigger",
    chat_id: "oc_1",
    action_value: JSON.stringify({ cmd: "/stop", key: "oc_missing" }),
    token: "tok_2",
  });
  assert.equal(result.status, "no-task");
});

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handler-task-"));
  return new TaskStore(path.join(dir, "tasks.db")).open();
}

test("带任务库时任务从排队记录到成功", async () => {
  const store = makeStore();
  const { handle } = makeHarness({ store });
  await (await handle(event())).run;

  const tasks = store.listByStatus("succeeded");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].messageId, "om_1");
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[0].sessionKey, "oc_1");
  store.close();
});

test("用户主动停止时在库中标记为 stopped", async () => {
  const store = makeStore();
  const { handle } = makeHarness({
    store,
    runMcp: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ text: "stopped", aborted: true }));
      }),
  });

  const first = await handle(event({ message_id: "om_abort" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await handle(event({ message_id: "om_stop", content: "/stop" }));
  await first.run;

  const tasks = store.listByStatus("stopped");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].error, "用户主动停止");
  assert.equal(store.listByStatus("interrupted").length, 0);
  store.close();
});

test("服务关闭中止任务时标记为中断以便重投", async () => {
  const store = makeStore();
  const { handle } = makeHarness({
    store,
    runMcp: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ text: "stopped", aborted: true }));
      }),
  });

  const first = await handle(event({ message_id: "om_shutdown" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  handle.abortAll();
  await first.run;

  const tasks = store.listByStatus("interrupted");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].error, "服务停止中断");
  assert.equal(store.listByStatus("stopped").length, 0);
  store.close();
});

test("单段结果原位更新后补发完成提醒", async () => {
  const { handle, events } = makeProgressHarness();
  await (await handle(event())).run;

  const notices = events.filter((item) => item.action === "replyText");
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /任务已完成/);
});

test("多段结果不补发完成提醒", async () => {
  const { handle, events } = makeProgressHarness({
    config: makeConfig({ replyChunkSize: 5, replyMaxChunks: 4 }),
    runMcp: async () => ({ text: "abcdefghij", sessionID: "ses_long" }),
  });
  await (await handle(event())).run;

  assert.equal(events.filter((item) => item.action === "replyText").length, 0);
});

test("关闭完成提醒后不补发", async () => {
  const { handle, events } = makeProgressHarness({
    config: makeConfig({ completionNotice: false }),
  });
  await (await handle(event())).run;

  assert.equal(events.filter((item) => item.action === "replyText").length, 0);
});

test("任务失败时补发失败提醒", async () => {
  const { handle, events } = makeProgressHarness({
    runMcp: async () => ({ error: "boom", text: "" }),
  });
  await (await handle(event())).run;

  const notices = events.filter((item) => item.action === "replyText");
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /任务失败/);
});

test("任务超时时把 stderr 尾部记录到任务表", async () => {
  const store = makeStore();
  const { handle } = makeHarness({
    store,
    runMcp: async () => ({
      timedOut: true,
      stderrTail: "模型请求超时：connect ETIMEDOUT",
      text: "",
    }),
  });

  await (await handle(event({ message_id: "om_timeout" }))).run;

  const tasks = store.listByStatus("failed");
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].error, /任务超时/);
  assert.match(tasks[0].error, /ETIMEDOUT/);
  store.close();
});

test("超长结果落盘并作为附件发回飞书", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "handler-out-"));
  const longText = Array.from({ length: 40 }, (_, i) => `第 ${i} 段内容`).join("\n\n");
  const { handle, files } = makeHarness({
    config: makeConfig({
      replyMaxChunks: 1,
      replyChunkSize: 60,
      attachLongOutput: true,
      outputDir,
    }),
    runMcp: async () => ({ text: longText, sessionID: "ses_long", exitCode: 0 }),
  });

  await (await handle(event())).run;

  assert.equal(files.length, 1);
  assert.equal(files[0].chatId, "oc_1");
  assert.match(files[0].file, /\.md$/);
  assert.ok(fs.existsSync(path.join(outputDir, files[0].file)));
});
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  buildConsumeArgs,
  buildReplyArgs,
  buildReplyCardArgs,
  buildSendArgs,
  buildSendFileArgs,
  buildSendMarkdownArgs,
  createNdjsonDecoder,
  parseFloodWait,
  LarkCli,
} from "../src/larkcli.js";

function fakeChild({ code = 0, stdout = "", stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {};
  process.nextTick(() => {
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  });
  return child;
}

test("构造事件消费、回复与发送命令", () => {
  assert.deepEqual(buildConsumeArgs({ eventKey: "im.message.receive_v1", identity: "bot" }), [
    "event",
    "consume",
    "im.message.receive_v1",
    "--as",
    "bot",
    "--quiet",
  ]);
  assert.deepEqual(buildReplyArgs({ messageId: "om_1", text: "hi", identity: "bot" }), [
    "im",
    "+messages-reply",
    "--message-id",
    "om_1",
    "--markdown",
    "hi",
    "--as",
    "bot",
  ]);
  assert.deepEqual(
    buildReplyArgs({ messageId: "om_1", text: "hi", identity: "bot", markdown: false }),
    ["im", "+messages-reply", "--message-id", "om_1", "--text", "hi", "--as", "bot"],
  );
  assert.deepEqual(buildSendArgs({ chatId: "oc_1", text: "hi", identity: "bot" }), [
    "im",
    "+messages-send",
    "--chat-id",
    "oc_1",
    "--text",
    "hi",
    "--as",
    "bot",
  ]);
  assert.deepEqual(
    buildReplyCardArgs({ messageId: "om_1", card: '{"a":1}', identity: "bot" }),
    [
      "im",
      "+messages-reply",
      "--message-id",
      "om_1",
      "--content",
      '{"a":1}',
      "--msg-type",
      "interactive",
      "--as",
      "bot",
    ],
  );
});

test("NDJSON 解码器支持跨块与坏行", () => {
  const events = [];
  const bad = [];
  const decoder = createNdjsonDecoder((obj) => events.push(obj), (line) => bad.push(line));
  decoder.push('{"a":1}\nnot json\n{"b"');
  decoder.push(':2}\n');
  decoder.flush();
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(bad, ["not json"]);
});

test("replyText 使用纯文本参数", async () => {
  const calls = [];
  const cli = new LarkCli({
    spawnImpl: (bin, args) => {
      calls.push({ bin, args });
      return fakeChild({ code: 0, stdout: "{}" });
    },
  });
  const result = await cli.replyText("om_1", "hello");
  assert.equal(result.code, 0);
  assert.equal(calls[0].bin, "lark-cli");
  assert.deepEqual(
    calls[0].args,
    buildReplyArgs({ messageId: "om_1", text: "hello", markdown: false }),
  );
});

test("replyMarkdown 使用 markdown 参数", async () => {
  const calls = [];
  const cli = new LarkCli({
    spawnImpl: (bin, args) => {
      calls.push({ bin, args });
      return fakeChild({ code: 0, stdout: "{}" });
    },
  });
  const result = await cli.replyMarkdown("om_1", "**hello**");
  assert.equal(result.code, 0);
  assert.ok(calls[0].args.includes("--markdown"));
  assert.ok(!calls[0].args.includes("--text"));
  assert.deepEqual(calls[0].args, buildReplyArgs({ messageId: "om_1", text: "**hello**" }));
});

test("replyCard 使用 interactive 卡片参数", async () => {
  const calls = [];
  const cli = new LarkCli({
    spawnImpl: (bin, args) => {
      calls.push({ bin, args });
      return fakeChild({ code: 0, stdout: "{}" });
    },
  });
  const card = '{"elements":[]}';
  const result = await cli.replyCard("om_1", card);
  assert.equal(result.code, 0);
  assert.deepEqual(
    calls[0].args,
    buildReplyCardArgs({ messageId: "om_1", card }),
  );
  assert.ok(calls[0].args.includes("--msg-type"));
  assert.ok(calls[0].args.includes("interactive"));
  assert.ok(!calls[0].args.includes("--markdown"));
});

test("version 在成功时返回版本号", async () => {
  const cli = new LarkCli({ spawnImpl: () => fakeChild({ code: 0, stdout: "1.0.84\n" }) });
  assert.equal(await cli.version(), "1.0.84");
});

test("status 在未配置时返回 ok=false", async () => {
  const cli = new LarkCli({ spawnImpl: () => fakeChild({ code: 1, stderr: "not configured" }) });
  const result = await cli.status();
  assert.equal(result.ok, false);
  assert.match(result.detail, /not configured/);
});

test("startConsuming 把 stdout 行解析为事件，stop 后不再重连", async () => {
  let spawnCount = 0;
  const events = [];
  const cli = new LarkCli({
    spawnImpl: () => {
      spawnCount += 1;
      return fakeChild({ code: 0, stdout: '{"type":"im.message.receive_v1","message_id":"om_1"}\n' });
    },
  });
  const consumer = cli.startConsuming({ onEvent: (event) => events.push(event) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, 1);
  assert.equal(events[0].message_id, "om_1");

  consumer.stop();
  const countAtStop = spawnCount;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(spawnCount, countAtStop);
});

test("解析消息资源并映射为本地路径", async () => {
  const lark = new LarkCli({
    spawnImpl: () =>
      fakeChild({
        stdout: JSON.stringify({
          ok: true,
          data: {
            messages: [
              {
                resources: [
                  { key: "img_1", local_path: "/tmp/a.png", size_bytes: 70, type: "image" },
                ],
              },
            ],
          },
        }),
      }),
  });
  const resources = await lark.fetchMessageResources("om_1", { cwd: "/tmp" });
  assert.deepEqual(resources, [
    { key: "img_1", localPath: "/tmp/a.png", sizeBytes: 70, type: "image" },
  ]);
});

test("资源接口失败时返回空数组", async () => {
  const lark = new LarkCli({ spawnImpl: () => fakeChild({ code: 1, stderr: "boom" }) });
  assert.deepEqual(await lark.fetchMessageResources("om_1"), []);
});

test("资源返回非法 JSON 时返回空数组", async () => {
  const lark = new LarkCli({ spawnImpl: () => fakeChild({ stdout: "not json" }) });
  assert.deepEqual(await lark.fetchMessageResources("om_1"), []);
});

test("按 token 更新卡片时构造正确的请求", async () => {
  const calls = [];
  const lark = new LarkCli({
    spawnImpl: (bin, args) => {
      calls.push(args);
      return fakeChild({ stdout: '{"ok":true}' });
    },
  });
  const card = JSON.stringify({ config: {}, elements: [] });
  const result = await lark.updateCardByToken("tok_1", card);
  assert.equal(result.code, 0);
  assert.deepEqual(calls[0].slice(0, 4), [
    "api",
    "POST",
    "/open-apis/interactive/v1/card/update",
    "--data",
  ]);
  assert.match(calls[0][4], /"token":"tok_1"/);
});

test("缺少 token 或卡片时不发请求", async () => {
  const lark = new LarkCli({ spawnImpl: () => fakeChild({}) });
  const result = await lark.updateCardByToken("", "");
  assert.equal(result.code, 1);
});

test("识别回调未订阅的错误信息", () => {
  const lark = new LarkCli({});
  assert.equal(lark.isUnsubscribedError("requires callbacks not subscribed"), true);
  assert.equal(lark.isUnsubscribedError("failed_precondition: callback missing"), true);
  assert.equal(lark.isUnsubscribedError("network timeout"), false);
  assert.equal(lark.isUnsubscribedError(""), false);
});

test("回调未订阅时停止重连并只提示一次", async () => {
  let spawnCount = 0;
  const errors = [];
  const lark = new LarkCli({
    eventKey: "card.action.trigger",
    logger: { error: (m) => errors.push(String(m)), warn: () => {}, debug: () => {} },
    spawnImpl: () => {
      spawnCount += 1;
      return fakeChild({
        code: 2,
        stderr: JSON.stringify({
          ok: false,
          error: {
            type: "validation",
            subtype: "failed_precondition",
            message: "EventKey card.action.trigger requires callbacks not subscribed in console",
          },
        }),
      });
    },
  });
  const handle = lark.startConsuming({ onEvent: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(spawnCount, 1);
  assert.ok(errors.some((m) => /停止重连/.test(m)));
  handle.stop();
});

test("parseFloodWait 解析限流等待时间", () => {
  assert.equal(parseFloodWait("retry after 12"), 12);
  assert.equal(parseFloodWait("HTTP 429 too many requests"), 30);
  assert.equal(parseFloodWait("普通错误"), 0);
  assert.equal(parseFloodWait(""), 0);
});

test("sendFile 与 sendMarkdown 使用对应参数", async () => {
  const calls = [];
  const lark = new LarkCli({
    spawnImpl: (bin, args) => {
      calls.push(args);
      return fakeChild({ code: 0, stdout: "{}" });
    },
  });
  await lark.sendFile("oc_1", "out.md", { cwd: "/tmp" });
  await lark.sendMarkdown("oc_1", "**hi**");

  assert.deepEqual(calls[0], buildSendFileArgs({ chatId: "oc_1", file: "out.md" }));
  assert.deepEqual(calls[1], buildSendMarkdownArgs({ chatId: "oc_1", text: "**hi**" }));
});

test("遇到 429 时进入洪泛窗口", async () => {
  const lark = new LarkCli({
    logger: { warn: () => {}, error: () => {}, debug: () => {} },
    spawnImpl: () => fakeChild({ code: 1, stderr: "429 rate limit retry after 5" }),
  });
  await lark.sendText("oc_1", "hi");

  assert.equal(lark.isFlooded(), true);
  assert.ok(lark.floodWaitMs() > 3000);
});
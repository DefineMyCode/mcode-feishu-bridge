import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildArgs, runMcp, summarizeResult } from "../src/mcode.js";

function fakeBinary(lines, { sleep = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-test-"));
  const file = path.join(dir, "fake-mcode");
  const body = lines.map((line) => `printf '%s\\n' ${JSON.stringify(line)}`).join("\n");
  fs.writeFileSync(
    file,
    `#!/bin/sh\ncat > "$PROMPT_FILE"\n${sleep ? `sleep ${sleep}\n` : ""}${body}\n`,
  );
  fs.chmodSync(file, 0o755);
  return { file, dir };
}

function promptFile(dir) {
  return path.join(dir, "prompt.json");
}

test("构造参数默认使用 stream-json 与 smart 权限", () => {
  assert.deepEqual(buildArgs({}), [
    "exec",
    "--output-format",
    "stream-json",
    "--permission",
    "smart",
    "--input",
    "-",
    "--input-format",
    "json",
  ]);
});

test("构造参数包含会话、模型、强度、模式、附件与步数", () => {
  const args = buildArgs({
    sessionId: "mvs_1",
    model: "minimax/MiniMax-M3.1-Flash",
    effort: "high",
    promptMode: "coding",
    permission: "full",
    files: ["/tmp/a.png"],
    maxSteps: 12,
    timeoutMs: 65000,
  });
  assert.deepEqual(args, [
    "exec",
    "--output-format",
    "stream-json",
    "--permission",
    "full",
    "--session",
    "mvs_1",
    "--model",
    "minimax/MiniMax-M3.1-Flash",
    "--effort",
    "high",
    "--prompt-mode",
    "coding",
    "--max-steps",
    "12",
    "--timeout",
    "65s",
    "--file",
    "/tmp/a.png",
    "--input",
    "-",
    "--input-format",
    "json",
  ]);
});

test("解析成功结果并回传会话与用量", async () => {
  const { file, dir } = fakeBinary([
    '{"schemaVersion":1,"sequence":1,"type":"exec.started","sessionId":"mvs_1"}',
    '{"schemaVersion":1,"sequence":2,"type":"item.completed","item":{"id":"i1","type":"agent_message","content":"OK"}}',
    '{"schemaVersion":1,"sequence":3,"type":"turn.completed","model":{"modelId":"MiniMax-M3.1-Flash"},"usage":{"inputTokens":10,"outputTokens":2},"durationMs":1200}',
    '{"schemaVersion":1,"sequence":4,"type":"exec.completed","result":{"status":"succeeded","output":"OK","sessionId":"mvs_1","usage":{"inputTokens":10,"outputTokens":2},"model":{"modelId":"MiniMax-M3.1-Flash"},"durationMs":1200}}',
  ]);
  const result = await runMcp({
    bin: file,
    prompt: "你好",
    cwd: dir,
    env: { ...process.env, PROMPT_FILE: promptFile(dir) },
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.text, "OK");
  assert.equal(result.sessionID, "mvs_1");
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.model.modelId, "MiniMax-M3.1-Flash");
  assert.equal(result.durationMs, 1200);
  assert.deepEqual(JSON.parse(fs.readFileSync(promptFile(dir), "utf8")), { prompt: "你好" });
});

test("工具事件触发 onToolCall 并记录工具名", async () => {
  const { file, dir } = fakeBinary([
    '{"schemaVersion":1,"sequence":1,"type":"item.started","item":{"id":"t1","type":"tool_call","toolCall":{"name":"grep","status":1}}}',
    '{"schemaVersion":1,"sequence":2,"type":"exec.completed","result":{"status":"succeeded","output":"done","sessionId":"mvs_2"}}',
  ]);
  const calls = [];
  const result = await runMcp({
    bin: file,
    prompt: "找一下",
    cwd: dir,
    env: { ...process.env, PROMPT_FILE: promptFile(dir) },
    onEvent: (event, state, info) => {
      if (info) calls.push(info.label);
    },
  });

  assert.deepEqual(calls, ["搜索代码"]);
  assert.deepEqual(result.toolCalls.map((item) => item.name), ["grep"]);
});

test("失败结果保留错误信息", async () => {
  const { file, dir } = fakeBinary([
    '{"schemaVersion":1,"sequence":1,"type":"turn.failed","status":"failed","error":{"category":"runtime","message":"模型不可用"},"durationMs":30}',
    '{"schemaVersion":1,"sequence":2,"type":"exec.completed","result":{"status":"failed","sessionId":"mvs_3","error":{"category":"runtime","message":"模型不可用"},"durationMs":30}}',
  ]);
  const result = await runMcp({
    bin: file,
    prompt: "hi",
    cwd: dir,
    env: { ...process.env, PROMPT_FILE: promptFile(dir) },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error, "模型不可用");
  assert.match(summarizeResult(result), /mcode 执行失败：模型不可用/);
});

test("启动失败时返回 spawnError", async () => {
  const result = await runMcp({
    bin: "/tmp/definitely-not-a-real-mcode-binary",
    prompt: "hi",
    cwd: "/tmp",
  });
  assert.ok(result.spawnError);
  assert.match(summarizeResult(result), /启动 mcode 失败/);
});

test("超时终止子进程并标记 timedOut", async () => {
  const { file, dir } = fakeBinary([], { sleep: 5 });
  const started = Date.now();
  const result = await runMcp({
    bin: file,
    prompt: "hi",
    cwd: dir,
    timeoutMs: 150,
    env: { ...process.env, PROMPT_FILE: promptFile(dir) },
  });
  assert.equal(result.timedOut, true);
  assert.match(summarizeResult(result), /任务超时/);
  assert.ok(Date.now() - started < 3000);
});

test("取消信号终止任务并标记 aborted", async () => {
  const { file, dir } = fakeBinary([], { sleep: 5 });
  const controller = new AbortController();
  const run = runMcp({
    bin: file,
    prompt: "hi",
    cwd: dir,
    signal: controller.signal,
    env: { ...process.env, PROMPT_FILE: promptFile(dir) },
  });
  setTimeout(() => controller.abort(), 50);
  const result = await run;
  assert.equal(result.aborted, true);
  assert.match(summarizeResult(result), /已停止当前任务/);
});

test("summarizeResult 覆盖无输出与 stderr 分支", () => {
  assert.match(summarizeResult({ exitCode: 0, stderrTail: "boom" }), /stderr 尾部/);
  assert.match(summarizeResult({ exitCode: 2 }), /退出码 2/);
  assert.match(summarizeResult({ status: "cancelled" }), /已取消/);
  assert.match(summarizeResult({ status: "limit_exceeded" }), /步数上限/);
  assert.equal(summarizeResult({ text: "ok" }), "ok");
});
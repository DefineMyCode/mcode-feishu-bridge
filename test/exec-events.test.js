import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEvent,
  createEventState,
  finalText,
  formatUsage,
  parseEventLine,
  toolLabel,
} from "../src/exec-events.js";

test("只解析 schemaVersion 1 的事件行", () => {
  assert.equal(parseEventLine("plain"), null);
  assert.equal(parseEventLine("{broken"), null);
  assert.equal(parseEventLine('{"type":"exec.started"}'), null);
  assert.deepEqual(parseEventLine('{"schemaVersion":1,"type":"exec.started"}'), {
    schemaVersion: 1,
    type: "exec.started",
  });
});

test("工具名映射为中文标签并保底原样返回", () => {
  assert.equal(toolLabel("grep"), "搜索代码");
  assert.equal(toolLabel("run_code"), "运行代码");
  assert.equal(toolLabel("unknown_tool"), "unknown_tool");
  assert.equal(toolLabel(""), "工具");
});

test("聚合消息与最终文本", () => {
  const state = createEventState();
  applyEvent(state, {
    type: "item.completed",
    item: { id: "i1", type: "agent_message", content: "第一段" },
  });
  applyEvent(state, {
    type: "item.completed",
    item: { id: "i2", type: "agent_message", content: "第二段" },
  });
  assert.equal(finalText(state, null), "第二段");
  assert.equal(finalText(state, { output: "最终结果" }), "最终结果");
});

test("工具调用开始与结束维护当前工具", () => {
  const state = createEventState();
  const events = [];
  applyEvent(
    state,
    {
      type: "item.started",
      item: { id: "t1", type: "tool_call", toolCall: { name: "read" } },
    },
    { onToolCall: (info) => events.push(info.label) },
  );
  assert.equal(state.currentTool, "读取文件");
  assert.deepEqual(events, ["读取文件"]);

  applyEvent(state, {
    type: "item.completed",
    item: { id: "t1", type: "tool_call", toolCall: { name: "read" } },
  });
  assert.equal(state.currentTool, "");
});

test("turn.completed 记录模型、用量与耗时", () => {
  const state = createEventState();
  applyEvent(state, {
    type: "turn.completed",
    model: { modelId: "MiniMax-M3.1-Flash" },
    usage: { inputTokens: 3, outputTokens: 5 },
    durationMs: 900,
  });
  assert.equal(state.status, "succeeded");
  assert.equal(state.model.modelId, "MiniMax-M3.1-Flash");
  assert.equal(state.usage.outputTokens, 5);
  assert.equal(state.durationMs, 900);
});

test("turn.failed 与 exec.completed 传递失败状态", () => {
  const state = createEventState();
  applyEvent(state, {
    type: "turn.failed",
    status: "timeout",
    error: { message: "超时" },
    durationMs: 1000,
  });
  assert.equal(state.status, "timeout");
  assert.equal(state.error, "超时");

  applyEvent(state, {
    type: "exec.completed",
    result: { status: "failed", error: { message: "最终失败" } },
  });
  assert.equal(state.status, "failed");
  assert.equal(state.error, "最终失败");
});

test("formatUsage 组合模型、token 与耗时", () => {
  assert.equal(
    formatUsage({
      model: { modelId: "MiniMax-M3.1-Flash" },
      usage: { inputTokens: 10, outputTokens: 20 },
      durationMs: 1500,
    }),
    "MiniMax-M3.1-Flash · 输入 10 / 输出 20 tokens · 1.5s",
  );
  assert.equal(formatUsage({}), "");
});
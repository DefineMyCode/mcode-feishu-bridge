const TOOL_LABELS = {
  read: "读取文件",
  write: "写入文件",
  edit: "修改文件",
  multi_edit: "批量修改文件",
  grep: "搜索代码",
  glob: "查找文件",
  ls: "列出目录",
  bash: "执行命令",
  shell: "执行命令",
  run_code: "运行代码",
  web_search: "搜索网页",
  web_fetch: "抓取网页",
  fetch: "抓取网页",
  todo_write: "更新任务清单",
  task: "调用子任务",
};

export function parseEventLine(line) {
  const text = String(line ?? "").trim();
  if (!text.startsWith("{")) return null;
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  if (event.schemaVersion !== 1) return null;
  return event;
}

export function toolLabel(name) {
  const key = String(name ?? "").toLowerCase();
  return TOOL_LABELS[key] || String(name ?? "") || "工具";
}

export function createEventState() {
  return {
    text: "",
    messages: [],
    toolCalls: [],
    currentTool: "",
    model: null,
    usage: null,
    durationMs: 0,
    status: "",
    error: "",
  };
}

export function applyEvent(state, event, { onToolCall } = {}) {
  if (!event || typeof event !== "object") return state;
  switch (event.type) {
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = event.item || {};
      if (item.type === "agent_message") {
        if (typeof item.contentDelta === "string" && item.contentDelta) {
          state.text += item.contentDelta;
        }
        if (event.type === "item.completed" && typeof item.content === "string" && item.content) {
          state.messages.push(item.content);
        }
      }
      if (item.type === "tool_call") {
        const call = item.toolCall || {};
        const label = toolLabel(call.name);
        if (event.type === "item.started") {
          state.currentTool = label;
          state.toolCalls.push({ name: call.name || "", label, status: call.status });
          onToolCall?.({ label, call, event });
        } else if (event.type === "item.completed") {
          state.currentTool = "";
        }
      }
      break;
    }
    case "turn.completed": {
      state.model = event.model || state.model;
      state.usage = event.usage || state.usage;
      state.durationMs = Number(event.durationMs) || state.durationMs;
      state.status = "succeeded";
      break;
    }
    case "turn.failed": {
      state.status = event.status || "failed";
      state.error = event.error?.message || "";
      state.durationMs = Number(event.durationMs) || state.durationMs;
      break;
    }
    case "exec.completed": {
      const result = event.result || {};
      state.status = result.status || state.status;
      state.error = result.error?.message || state.error;
      state.usage = result.usage || state.usage;
      state.model = result.model || state.model;
      state.durationMs = Number(result.durationMs) || state.durationMs;
      break;
    }
    default:
      break;
  }
  return state;
}

export function finalText(state, result) {
  if (result && typeof result.output === "string" && result.output.trim()) {
    return result.output.trim();
  }
  if (state.messages.length > 0) return state.messages.at(-1).trim();
  return state.text.trim();
}

export function formatUsage({ usage, durationMs, model } = {}) {
  const parts = [];
  if (model?.modelId) parts.push(model.modelId);
  if (usage && (usage.inputTokens || usage.outputTokens)) {
    parts.push(`输入 ${usage.inputTokens ?? 0} / 输出 ${usage.outputTokens ?? 0} tokens`);
  }
  if (durationMs > 0) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}
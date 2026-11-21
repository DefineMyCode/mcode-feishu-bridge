import { spawn as defaultSpawn } from "node:child_process";
import {
  applyEvent,
  createEventState,
  finalText,
  formatUsage,
  parseEventLine,
} from "./exec-events.js";

const MAX_STDERR = 4000;

export const PERMISSION_POLICIES = ["smart", "full", "off"];
export const PROMPT_MODES = ["tui", "coding", "work"];

export function buildArgs({
  sessionId = "",
  model = "",
  effort = "",
  promptMode = "",
  permission = "smart",
  files = [],
  maxSteps = 0,
  timeoutMs = 0,
} = {}) {
  const args = ["exec", "--output-format", "stream-json", "--permission", permission];
  if (sessionId) args.push("--session", sessionId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (promptMode) args.push("--prompt-mode", promptMode);
  if (maxSteps > 0) args.push("--max-steps", String(maxSteps));
  if (timeoutMs > 0) args.push("--timeout", `${Math.max(1, Math.floor(timeoutMs / 1000))}s`);
  for (const file of files) {
    if (file) args.push("--file", file);
  }
  args.push("--input", "-", "--input-format", "json");
  return args;
}

export function runMcp({
  bin = "mcode",
  prompt,
  cwd,
  sessionId = "",
  model = "",
  effort = "",
  promptMode = "",
  permission = "smart",
  files = [],
  maxSteps = 0,
  timeoutMs = 1800000,
  signal,
  onEvent,
  spawnImpl = defaultSpawn,
  env = process.env,
} = {}) {
  return new Promise((resolve) => {
    const state = createEventState();
    const args = buildArgs({
      sessionId,
      model,
      effort,
      promptMode,
      permission,
      files,
      maxSteps,
      timeoutMs,
    });
    const child = spawnImpl(bin, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.stdin.on?.("error", () => {});
    const killTree = (signal) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // 进程组已退出或权限不足时退回单进程终止
        }
      }
      child.kill(signal);
    };

    let buffer = "";
    let stderrTail = "";
    let resolvedSession = sessionId;
    let execResult = null;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        text: finalText(state, execResult),
        sessionID: execResult?.sessionId || resolvedSession,
        status: execResult?.status || state.status,
        error: execResult?.error?.message || state.error,
        usage: execResult?.usage || state.usage,
        model: execResult?.model || state.model,
        durationMs: Number(execResult?.durationMs) || state.durationMs,
        toolCalls: state.toolCalls,
        stderrTail: stderrTail.trim(),
        timedOut,
        aborted,
        ...extra,
      });
    };

    const consume = (line) => {
      const event = parseEventLine(line);
      if (!event) return;
      if (event.sessionId) resolvedSession = event.sessionId;
      applyEvent(state, event, {
        onToolCall: (info) => {
          try {
            onEvent?.(event, state, info);
          } catch {
            // 进度回调失败不影响任务
          }
        },
      });
      if (event.type === "exec.completed" && event.result) {
        execResult = event.result;
      }
      if (event.type !== "item.started" && event.type !== "item.updated") {
        try {
          onEvent?.(event, state);
        } catch {
          // 同上
        }
      }
    };

    const onAbort = () => {
      aborted = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 3000).unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 3000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (data) => {
      buffer += data;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });
    child.stderr.setEncoding?.("utf8");
    child.stderr.on("data", (data) => {
      stderrTail = (stderrTail + data).slice(-MAX_STDERR);
    });

    child.on("error", (err) => finish({ exitCode: null, spawnError: err.message }));
    child.on("close", (code) => {
      if (buffer.trim()) consume(buffer);
      finish({ exitCode: code });
    });

    try {
      child.stdin.write(JSON.stringify({ prompt: String(prompt ?? "") }));
      child.stdin.end();
    } catch {
      finish({ exitCode: null, spawnError: "无法写入 stdin" });
    }
  });
}

export function summarizeResult(result, { limit = 600 } = {}) {
  if (result.spawnError) return `启动 mcode 失败：${result.spawnError}`;
  if (result.aborted) return "已停止当前任务。";
  if (result.timedOut || result.status === "timeout") return "任务超时，已终止。";
  if (result.status === "cancelled") return "任务已取消。";
  if (result.status === "limit_exceeded") return "任务达到步数上限，已终止。";
  if (result.status === "failed" || result.error) {
    const message = result.error || "未知错误";
    return `mcode 执行失败：${message}`;
  }
  if (result.text) return result.text;
  const tail = String(result.stderrTail || "").slice(-limit);
  if (tail) return `mcode 没有输出文本，stderr 尾部：\n${tail}`;
  return `mcode 退出码 ${result.exitCode}，没有输出。`;
}

export { formatUsage };
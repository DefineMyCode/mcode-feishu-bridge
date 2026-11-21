import { summarizeResult } from "./mcode.js";

export function parseCronTasks(raw) {
  const tasks = [];
  for (const entry of String(raw ?? "").split(/[;\n]+/)) {
    const line = entry.trim();
    if (!line) continue;
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 3) continue;
    const [cron, prompt, chatId] = parts;
    if (!cron || !prompt || !chatId) continue;
    tasks.push({ cron, prompt, chatId });
  }
  return tasks;
}

function matchField(value, spec) {
  for (const raw of String(spec).split(",")) {
    const part = raw.trim();
    if (!part) continue;
    if (part === "*") return true;

    const stepOnly = part.match(/^\*\/(\d+)$/);
    if (stepOnly) {
      const step = Number(stepOnly[1]);
      if (step > 0 && value % step === 0) return true;
      continue;
    }

    const rangeStep = part.match(/^(\d+)-(\d+)\/(\d+)$/);
    if (rangeStep) {
      const [from, to, step] = rangeStep.slice(1).map(Number);
      if (step > 0 && value >= from && value <= to && (value - from) % step === 0) return true;
      continue;
    }

    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (value >= from && value <= to) return true;
      continue;
    }

    if (/^\d+$/.test(part) && Number(part) === value) return true;
  }
  return false;
}

export function cronMatches(expr, date = new Date()) {
  const fields = String(expr ?? "").trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return (
    matchField(date.getMinutes(), fields[0]) &&
    matchField(date.getHours(), fields[1]) &&
    matchField(date.getDate(), fields[2]) &&
    matchField(date.getMonth() + 1, fields[3]) &&
    matchField(date.getDay(), fields[4])
  );
}

export function createScheduler({
  tasks = [],
  config,
  queue,
  lark,
  runMcp,
  logger,
  intervalMs = 60000,
  now = () => new Date(),
} = {}) {
  if (tasks.length === 0) {
    return { stop() {}, running: false };
  }

  let lastKey = "";

  function tick() {
    const date = now();
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
    if (key === lastKey) return;
    lastKey = key;

    tasks.forEach((task, index) => {
      if (!cronMatches(task.cron, date)) return;

      const runKey = `cron:${index}:${key}`;
      const run = queue.push(runKey, async () => {
        try {
          logger?.info?.(`定时任务触发 | ${task.cron} | ${task.chatId}`);
          const result = await runMcp({
            bin: config.mcodeBin,
            prompt: task.prompt,
            cwd: config.workdir,
            model: config.model,
            effort: config.effort,
            promptMode: config.promptMode,
            permission: config.permission,
            timeoutMs: config.timeoutMs,
            maxSteps: config.maxSteps,
          });
          const text = summarizeResult(result);
          const sent = await lark.sendMarkdown(task.chatId, `**⏰ 定时任务**\n\n${text}`);
          if (sent.code !== 0) {
            logger?.error?.(
              "定时任务投递失败",
              (sent.stderr || sent.error || "").slice(0, 300),
            );
          }
        } catch (err) {
          logger?.error?.("定时任务执行失败", err);
        }
      });
      run.catch((err) => logger?.error?.("定时任务队列异常", err));
    });
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    running: true,
    stop() {
      clearInterval(timer);
    },
  };
}
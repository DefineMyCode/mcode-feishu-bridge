import fs from "node:fs";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { LarkCli } from "./larkcli.js";
import { SessionStore } from "./sessions.js";
import { TaskQueue } from "./queue.js";
import { Deduper } from "./message.js";
import { TextBatcher } from "./batching.js";
import { createMessageHandler } from "./handler.js";
import { runMcp } from "./mcode.js";
import { cleanMediaDir } from "./media.js";
import { TaskStore } from "./taskstore.js";
import { recoverTasks, syncWorkspace } from "./recovery.js";
import { buildProgressCard } from "./card.js";
import { createScheduler } from "./scheduler.js";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });

if (!fs.existsSync(config.workdir)) {
  logger.error(`MCODE_WORKDIR 不存在：${config.workdir}`);
  process.exit(1);
}

const store = new TaskStore(config.taskDb, { logger }).open();
const migration = store.importJson({
  sessionsFile: config.stateFile,
  dedupFile: config.dedupFile,
  ttlMs: config.dedupTtlMs,
});
if (migration.sessions > 0 || migration.dedup > 0) {
  logger.info(`已从 JSON 迁移 ${migration.sessions} 条会话、${migration.dedup} 条去重记录`);
}
store.pruneDedup({ ttlMs: config.dedupTtlMs, max: config.dedupMax });
syncWorkspace(store, config.workdir, logger);

const sessions = new SessionStore(config.stateFile, { logger, store }).load();
const queue = new TaskQueue({ maxConcurrency: config.maxConcurrency });
const deduper = new Deduper(
  { max: config.dedupMax, ttlMs: config.dedupTtlMs, logger },
  { store },
).load();
const lark = new LarkCli({
  bin: config.larkBin,
  identity: config.larkIdentity,
  eventKey: config.eventKey,
  logger,
  baseArgs: config.larkProfile ? ["--profile", config.larkProfile] : [],
});

const version = await lark.version();
if (!version) {
  logger.error(`找不到 lark-cli（${config.larkBin}），请安装或设置 LARK_CLI_BIN 为绝对路径`);
  process.exit(1);
}
logger.info(`lark-cli ${version} 就绪`);

const status = await lark.status();
if (!status.ok) {
  const detail = String(status.detail || "");
  if (detail.includes("not_configured") || detail.includes("not configured")) {
    logger.error("lark-cli 尚未配置应用，请先执行：lark-cli config init --new && lark-cli auth login");
    process.exit(1);
  }
  logger.warn(`lark-cli 身份检查失败，继续启动：${detail.slice(0, 200)}`);
}

let handle;
const batcher = new TextBatcher({
  delayMs: config.textBatchDelayMs,
  maxMessages: config.textBatchMaxMessages,
  maxChars: config.textBatchMaxChars,
  onFlush: (message) => {
    const run = handle.startRun(message);
    if (run && typeof run.catch === "function") {
      run.catch((err) => logger.error("批处理任务执行失败", err));
    }
  },
});

handle = createMessageHandler({
  config,
  sessions,
  queue,
  lark,
  logger,
  runMcp,
  deduper,
  batcher,
  store,
});

const recovery = await recoverTasks({
  store,
  config,
  logger,
  submit: (task) => {
    const run = handle.startTask(task);
    if (run && typeof run.catch === "function") {
      run.catch((err) => logger.error("恢复任务执行失败", err));
    }
  },
  notifyInterrupted: async (task, reason) => {
    const text = `任务已中断：${reason}。可以重新发送，或等待后续自动重试。`;
    const stale = Date.now() - Number(task.createdAt || 0) > 25 * 60 * 1000;
    if (task.progressMessageId && !stale) {
      const card = buildProgressCard({ title: "任务已中断", text, template: "orange" });
      const result = await lark.updateCard(task.progressMessageId, card);
      if (result?.code === 0) return;
    }
    await lark.sendText(task.chatId, text);
  },
});
logger.info(
  `启动恢复完成 | 中断=${recovery.interrupted} 重投=${recovery.requeued} 投递=${recovery.submitted}`,
);

const taskRetentionMs =
  config.taskRetentionDays > 0 ? config.taskRetentionDays * 24 * 60 * 60 * 1000 : 0;
const removedTasks = store.cleanupTasks({ retentionMs: taskRetentionMs });
if (removedTasks > 0) logger.info(`已清理 ${removedTasks} 个过期任务记录`);

const scheduler = createScheduler({
  tasks: config.cronTasks,
  config,
  queue,
  lark,
  runMcp,
  logger,
});
if (scheduler.running) {
  logger.info(`定时任务已启用 | ${config.cronTasks.length} 条`);
}

const consumer = lark.startConsuming({
  onEvent: (event) => {
    handle(event).catch((err) => logger.error("消息处理失败", err));
  },
  onFatal: (detail) => logger.error("事件流持续重连失败，请检查 lark-cli 配置:", detail),
});

const cardLark = new LarkCli({
  bin: config.larkBin,
  identity: config.larkIdentity,
  eventKey: "card.action.trigger",
  logger,
  baseArgs: config.larkProfile ? ["--profile", config.larkProfile] : [],
});
const cardConsumer = cardLark.startConsuming({
  onEvent: (event) => {
    handle.cardAction(event).catch((err) => logger.error("卡片回调处理失败", err));
  },
  onFatal: (detail) => logger.error("卡片回调流持续重连失败:", detail),
});

const retentionMs =
  config.mediaRetentionDays > 0 ? config.mediaRetentionDays * 24 * 60 * 60 * 1000 : 0;
const initialClean = cleanMediaDir(config.mediaDir, { retentionMs, logger });
if (initialClean.removed > 0) {
  logger.info(`已清理 ${initialClean.removed} 个过期附件（保留 ${initialClean.kept} 个）`);
}
const mediaTimer = setInterval(() => {
  try {
    const result = cleanMediaDir(config.mediaDir, { retentionMs, logger });
    if (result.removed > 0) logger.info(`已清理 ${result.removed} 个过期附件`);
  } catch (err) {
    logger.warn("清理附件失败", err);
  }
}, 24 * 60 * 60 * 1000);
mediaTimer.unref?.();

if (config.permission === "full") {
  logger.warn("已启用 full 权限：任务将跳过沙箱与全部安全检查，请务必配置 ALLOWED_CHAT_IDS");
}
if (config.permission === "off") {
  logger.warn("已启用 off 权限：mcode 不会请求任何确认，请确认工作目录与访问范围可控");
}
if (config.groupSessionsPerUser) {
  logger.info("群聊会话按参与者隔离已开启（GROUP_SESSIONS_PER_USER=true）");
}

logger.info(
  `桥接已启动 | 工作目录=${config.workdir} | 事件=${config.eventKey} | 并发=${config.maxConcurrency} | 权限=${config.permission}`,
);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info(`收到 ${signal}，正在退出`);
  consumer.stop();
  cardConsumer.stop();
  scheduler.stop();
  clearInterval(mediaTimer);
  batcher.stop();
  try {
    batcher.flushAll();
  } catch (err) {
    logger.error("刷新批处理队列失败", err);
  }
  try {
    handle.abortAll?.();
  } catch (err) {
    logger.error("中止任务失败", err);
  }
  const deadline = Date.now() + 4000;
  while (store.countByStatus().running > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  try {
    const left = store.markRunningAsInterrupted({ error: "服务停止中断" });
    if (left > 0) logger.warn(`仍有 ${left} 个任务未结束，已标记为中断`);
  } catch (err) {
    logger.error("标记中断任务失败", err);
  }
  try {
    sessions.save();
    deduper.save();
  } catch (err) {
    logger.error("保存状态失败", err);
  }
  try {
    store.close();
  } catch (err) {
    logger.error("关闭数据库失败", err);
  }
  setTimeout(() => process.exit(0), 300).unref();
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((err) => logger.error("退出失败", err));
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((err) => logger.error("退出失败", err));
});
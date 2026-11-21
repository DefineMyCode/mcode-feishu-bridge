import fs from "node:fs";
import path from "node:path";
import {
  normalizeEvent,
  isAddressedToBot,
  parseCommand,
  Deduper,
} from "./message.js";
import { buildSessionKey } from "./sessions.js";
import { chunkText, splitText } from "./text.js";
import { saveOutput } from "./output.js";
import { formatUsage, summarizeResult } from "./mcode.js";
import { buildCardMarkdown, buildProgressCard } from "./card.js";
import { extractMessageId } from "./larkcli.js";
import { composePrompt, extractResources, isMediaMessage } from "./media.js";
import { taskToMessage } from "./recovery.js";

const HELP_TEXT = [
  "MiniMax Code 飞书桥接命令：",
  "/help   显示本帮助",
  "/new    结束当前会话上下文，下一条消息开启新会话",
  "/stop   终止当前正在执行的任务",
  "/status 查看当前会话、模型与任务状态",
  "/model  查看或切换本会话模型，例如 /model minimax/MiniMax-M3.1-Flash",
  "/effort 查看或切换本会话推理强度，例如 /effort high",
  "/init   让 mcode 分析当前项目并生成 AGENTS.md",
  "",
  "直接发送文本即会把任务交给 mcode 执行；群聊中需要 @机器人。",
].join("\n");

export function createMessageHandler({
  config,
  sessions,
  queue,
  lark,
  logger,
  runMcp,
  deduper,
  batcher,
  store,
}) {
  const seen = deduper || new Deduper(500);
  const perUser = config.groupSessionsPerUser !== false;
  const rules = config.groupRules || {};
  const allowedUserIds = config.allowedUserIds || [];
  const globalPolicy = config.groupPolicy || "open";
  const reactionsEnabled = config.reactions !== false;
  const running = new Map();
  const modelOverrides = new Map();
  const effortOverrides = new Map();

  function sessionKeyFor(message) {
    return buildSessionKey({
      chatId: message.chatId,
      senderId: message.senderId,
      chatType: message.chatType,
      perUser,
    });
  }

  function sessionFor(message) {
    return sessions.getWithFallback(sessionKeyFor(message), message.chatId);
  }

  function resolveAccess(message) {
    const rule = rules[message.chatId] || null;
    const policy = rule?.policy || globalPolicy;
    const allowlist = rule?.allowlist?.length ? rule.allowlist : allowedUserIds;
    const blacklist = rule?.blacklist || [];
    if (policy === "disabled") return { allowed: false, reason: "group-disabled" };
    if (blacklist.includes(message.senderId)) {
      return { allowed: false, reason: "user-blacklisted" };
    }
    if (allowlist.length > 0 && !allowlist.includes(message.senderId)) {
      return { allowed: false, reason: "user-not-allowed" };
    }
    if (
      policy === "allowlist" &&
      allowlist.length === 0 &&
      message.chatType !== "p2p"
    ) {
      return { allowed: false, reason: "allowlist-empty" };
    }
    const requireMention =
      rule?.requireMention === undefined ? config.requireMentionInGroup : rule.requireMention;
    return { allowed: true, requireMention };
  }

  async function sendOne(messageId, chunk) {
    const format = config.replyFormat || "card";
    const attempts = [];

    if (format === "card" && lark.replyCard) {
      attempts.push(() => lark.replyCard(messageId, buildCardMarkdown(chunk)));
    }
    if (format !== "text" && lark.replyMarkdown) {
      attempts.push(() => lark.replyMarkdown(messageId, chunk));
    }
    if (lark.replyText) {
      attempts.push(() => lark.replyText(messageId, chunk));
    }

    let last = { code: 1 };
    for (let i = 0; i < attempts.length; i += 1) {
      last = await attempts[i]();
      if (last.code === 0) return true;
      logger?.warn?.(
        `回复失败（${format}），尝试下一种格式`,
        (last.stderr || last.error || "").slice(0, 200),
      );
    }
    logger?.error("回复飞书消息失败", (last.stderr || last.error || "").slice(0, 300));
    return false;
  }

  async function reply(messageId, text, { progressMessageId = "", chatId = "" } = {}) {
    const { chunks, truncated } = splitText(text, config.replyChunkSize, config.replyMaxChunks);
    let updatedProgress = false;
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (i === 0 && progressMessageId) {
        const updated = await lark.updateCard(progressMessageId, buildCardMarkdown(chunk));
        if (updated?.code === 0) {
          updatedProgress = true;
          continue;
        }
        logger?.warn?.(
          "更新进度卡片失败，改为发送新消息",
          (updated?.stderr || updated?.error || "").slice(0, 200),
        );
      }
      if (!(await sendOne(messageId, chunk))) return { ok: false, updatedProgress };
    }

    if (truncated && config.attachLongOutput && chatId) {
      try {
        const saved = saveOutput({ dir: config.outputDir, key: chatId, text });
        const sent = await lark.sendFile(chatId, saved.name, { cwd: config.outputDir });
        if (sent?.code !== 0) {
          await lark.sendText(chatId, `完整输出已保存到服务器：${saved.path}`);
        }
      } catch (err) {
        logger?.warn?.("保存或上传长输出失败", err?.message || String(err));
      }
    }

    return { ok: true, updatedProgress };
  }

  async function maybeNotifyCompletion(message, { summary, result, updatedProgress }) {
    if (config.completionNotice === false || !updatedProgress) return;
    if (chunkText(summary, config.replyChunkSize, config.replyMaxChunks).length > 1) return;
    let text = "任务已完成，结果见上方卡片。";
    if (result.aborted) {
      text = "任务已停止。";
    } else if (result.error || result.spawnError || result.timedOut) {
      text = "任务失败，详情见上方卡片。";
    }
    try {
      await lark.replyText(message.messageId, text);
    } catch (err) {
      logger?.debug?.("完成提醒发送失败", err?.message || String(err));
    }
  }

  function withUsage(text, result) {
    const meta = formatUsage({
      usage: result.usage,
      durationMs: result.durationMs,
      model: result.model,
    });
    if (!meta) return text;
    return `${text}\n\n---\n${meta}`;
  }

  function progressCardEnabled() {
    return (
      config.progressCard !== false &&
      typeof lark.replyCard === "function" &&
      typeof lark.updateCard === "function"
    );
  }

  async function preparePrompt(message) {
    if (config.mediaEnabled === false) return { prompt: message.text, files: [] };
    if (message.messageType !== "post" && !isMediaMessage(message)) {
      return { prompt: message.text, files: [] };
    }
    const resources = await resolveResources(message);
    if (resources.length === 0) {
      if (isMediaMessage(message) && !message.text) {
        return { prompt: "用户发送了附件，但桥接未能下载到本地。", files: [] };
      }
      return { prompt: message.text, files: [] };
    }
    return {
      prompt: composePrompt(message.text, resources, {
        maxBytes: config.textInjectMaxBytes,
        maxChars: config.textInjectMaxChars,
      }),
      files: resources.map((item) => item.localPath).filter(Boolean),
    };
  }

  async function resolveResources(message) {
    if (
      typeof lark.fetchMessageDetail !== "function" ||
      typeof lark.downloadResource !== "function"
    ) {
      return [];
    }
    let detail = null;
    try {
      detail = await lark.fetchMessageDetail(message.messageId);
    } catch (err) {
      logger?.warn?.("读取消息详情失败", err?.message || String(err));
      return [];
    }
    if (!detail) return [];
    const candidates = extractResources(detail.content);
    if (candidates.length === 0) return [];

    if (config.mediaDir) {
      try {
        fs.mkdirSync(config.mediaDir, { recursive: true });
      } catch (err) {
        logger?.warn?.("创建附件目录失败", err?.message || String(err));
        return [];
      }
    }

    const resources = [];
    for (const candidate of candidates) {
      const ext = path.extname(candidate.fileName || "");
      const output = `${candidate.fileKey}${ext}`;
      let saved = null;
      try {
        saved = await lark.downloadResource({
          messageId: message.messageId,
          fileKey: candidate.fileKey,
          type: candidate.type,
          output,
          cwd: config.mediaDir,
        });
      } catch (err) {
        logger?.warn?.("下载附件失败", err?.message || String(err));
      }
      if (saved) resources.push({ ...saved, fileName: candidate.fileName });
    }
    return resources;
  }

  async function markProcessing(message) {
    if (!reactionsEnabled || !lark.addReaction) return "";
    try {
      return await lark.addReaction(message.messageId, config.reactionProcessingEmoji || "Typing");
    } catch {
      return "";
    }
  }

  async function clearProcessing(message, reactionId) {
    if (!reactionId || !lark.removeReaction) return;
    try {
      await lark.removeReaction(message.messageId, reactionId);
    } catch {
      // 表情清理失败不影响主流程
    }
  }

  async function markFailure(message) {
    if (!reactionsEnabled || !lark.addReaction) return;
    try {
      await lark.addReaction(message.messageId, config.reactionFailureEmoji || "CrossMark");
    } catch {
      // 表情失败静默
    }
  }

  async function handleCommand(command, message) {
    switch (command) {
      case "/help":
        return reply(message.messageId, HELP_TEXT);
      case "/new": {
        const key = sessionKeyFor(message);
        sessions.clear(key);
        if (key !== message.chatId) sessions.clear(message.chatId);
        sessions.save();
        return reply(message.messageId, "已新建会话，下一条消息将开启新的上下文。");
      }
      case "/stop": {
        const controller = running.get(sessionKeyFor(message));
        if (!controller) return reply(message.messageId, "当前没有正在执行的任务。");
        controller.userRequested = true;
        controller.abort();
        return reply(message.messageId, "已发送停止信号。");
      }
      case "/status": {
        const key = sessionKeyFor(message);
        const sessionId = sessionFor(message);
        const masked = sessionId ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : "无";
        const state = running.has(key) ? "执行中" : "空闲";
        return reply(
          message.messageId,
          [
            `状态：${state}`,
            `会话：${masked}`,
            `会话键：${key}`,
            `模型：${modelOverrides.get(key) || config.model || "账号默认"}`,
            `推理强度：${effortOverrides.get(key) || config.effort || "账号默认"}`,
            `队列中活跃会话：${queue.pending}`,
          ].join("\n"),
        );
      }
      case "/model": {
        const key = sessionKeyFor(message);
        const current = modelOverrides.get(key) || config.model;
        const arg = String(message.text || "").trim().split(/\s+/).slice(1).join(" ");
        if (!arg) {
          return reply(
            message.messageId,
            `当前模型：${current || "账号默认"}\n用法：/model <provider/model>，或 /model reset 恢复默认。`,
          );
        }
        if (["reset", "default"].includes(arg.toLowerCase())) {
          modelOverrides.delete(key);
          return reply(message.messageId, `已恢复默认模型：${config.model || "账号默认"}`);
        }
        modelOverrides.set(key, arg);
        return reply(message.messageId, `本会话模型已切换为：${arg}`);
      }
      case "/effort": {
        const key = sessionKeyFor(message);
        const current = effortOverrides.get(key) || config.effort;
        const arg = String(message.text || "").trim().split(/\s+/).slice(1).join(" ");
        if (!arg) {
          return reply(
            message.messageId,
            `当前推理强度：${current || "账号默认"}\n用法：/effort <level>，或 /effort reset 恢复默认。`,
          );
        }
        if (["reset", "default"].includes(arg.toLowerCase())) {
          effortOverrides.delete(key);
          return reply(message.messageId, `已恢复默认推理强度：${config.effort || "账号默认"}`);
        }
        effortOverrides.set(key, arg);
        return reply(message.messageId, `本会话推理强度已切换为：${arg}`);
      }
      case "/init": {
        return startRun(
          {
            ...message,
            text: "分析当前项目结构、项目规则与可用脚本，生成或更新 AGENTS.md。",
          },
          { key: sessionKeyFor(message) },
        );
      }
      default:
        break;
    }
    return reply(message.messageId, HELP_TEXT);
  }

  function createTaskRecord(message, key) {
    if (!store) return null;
    return store.createTask({
      sessionKey: key,
      chatId: message.chatId,
      messageId: message.messageId,
      prompt: message.text || "",
      media: {
        chatType: message.chatType,
        messageType: message.messageType,
        mediaType: message.mediaType,
        text: message.text,
        mentions: message.mentions,
        senderId: message.senderId,
      },
    });
  }

  function describeFailure(result, fallback) {
    const tail = String(result.stderrTail || "").trim().slice(-1500);
    return tail ? `${fallback}：${tail}` : fallback;
  }

  function recordResult(taskId, result, { userRequested = false, durationMs = 0 } = {}) {
    const seconds = Math.max(0, Math.round(durationMs / 1000));
    if (!store || !taskId) {
      logger?.info?.(`任务结束 | 未入库 | 耗时 ${seconds}s`);
      return;
    }
    if (result.aborted) {
      if (userRequested) {
        store.markStopped(taskId, { reason: "用户主动停止" });
        logger?.info?.(`任务结束 | ${taskId} | stopped | 耗时 ${seconds}s`);
      } else {
        store.markInterrupted(taskId, { error: "服务停止中断" });
        logger?.info?.(`任务结束 | ${taskId} | interrupted | 耗时 ${seconds}s`);
      }
      return;
    }
    if (result.timedOut) {
      const error = describeFailure(result, "任务超时");
      store.markFailed(taskId, { error });
      logger?.warn?.(`任务超时 | ${taskId} | 耗时 ${seconds}s | ${error.slice(-400)}`);
      return;
    }
    if (
      result.spawnError ||
      result.error ||
      (result.status && !["succeeded", ""].includes(result.status))
    ) {
      const error = describeFailure(
        result,
        result.spawnError || result.error || `mcode 状态：${result.status}`,
      );
      store.markFailed(taskId, { error });
      logger?.warn?.(`任务失败 | ${taskId} | 耗时 ${seconds}s | ${error.slice(-400)}`);
      return;
    }
    store.markSucceeded(taskId, { summary: summarizeResult(result).slice(0, 4000) });
    logger?.info?.(`任务结束 | ${taskId} | succeeded | 耗时 ${seconds}s`);
  }

  function startRun(message, { key: explicitKey, task = null } = {}) {
    const key = explicitKey || sessionKeyFor(message);
    if (!task && queue.isBusy(key)) {
      return reply(message.messageId, "上一个任务还在执行。发送 /stop 可终止，或稍后再试。");
    }

    const taskId = task ? task.id : createTaskRecord(message, key);
    const startedAt = Date.now();
    const controller = new AbortController();
    running.set(key, controller);

    const run = queue.push(key, async () => {
      const reactionId = await markProcessing(message);
      let progressMessageId = task?.progressMessageId || "";
      let heartbeatTimer = null;
      try {
        if (store && taskId) store.markRunning(taskId);
        logger?.info?.(`任务开始 | ${taskId || "未入库"} | ${key}`);
        if (progressCardEnabled()) {
          const sent = await lark.replyCard(
            message.messageId,
            buildProgressCard({
              actions: [
                { text: "停止任务", type: "danger", value: { cmd: "/stop", key } },
              ],
            }),
          );
          if (sent?.code === 0) {
            const sentId = extractMessageId(sent);
            if (sentId) {
              progressMessageId = sentId;
              if (store && taskId) store.setProgressMessageId(taskId, sentId);
            }
          }
        }
        if (!progressMessageId && config.ack) {
          await reply(message.messageId, "已收到，开始执行…（发送 /stop 可终止）");
        }
        const heartbeatMs = Math.max(0, (config.heartbeatMinutes || 0) * 60000);
        if (heartbeatMs > 0 && progressMessageId) {
          heartbeatTimer = setInterval(() => {
            if (typeof lark.isFlooded === "function" && lark.isFlooded()) return;
            const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
            const limit = Math.max(1, Math.round((config.timeoutMs || 0) / 60000));
            lark
              .updateCard(
                progressMessageId,
                buildProgressCard({
                  title: "任务执行中",
                  text: `⏳ 仍在执行…已用时 ${minutes} 分钟（上限 ${limit} 分钟）`,
                  actions: [
                    { text: "停止任务", type: "danger", value: { cmd: "/stop", key } },
                  ],
                }),
              )
              .catch(() => {});
          }, heartbeatMs);
          heartbeatTimer.unref?.();
        }

        const prepared =
          task && task.attempts > 0
            ? { prompt: task.prompt, files: [] }
            : await preparePrompt(message);
        const prompt = prepared.prompt;
        if (store && taskId) store.updatePrompt(taskId, prompt);
        let lastProgressAt = 0;
        const onEvent = (event, state, info) => {
          if (!info?.label || !progressMessageId || !progressCardEnabled()) return;
          const now = Date.now();
          if (now - lastProgressAt < config.progressIntervalMs) return;
          lastProgressAt = now;
          lark
            .updateCard(
              progressMessageId,
              buildProgressCard({
                title: "任务执行中",
                text: `正在执行：${info.label}`,
                actions: [
                  { text: "停止任务", type: "danger", value: { cmd: "/stop", key } },
                ],
              }),
            )
            .catch(() => {});
        };
        const result = await runMcp({
          bin: config.mcodeBin,
          prompt,
          cwd: config.workdir,
          sessionId: sessionFor(message),
          model: modelOverrides.get(key) || config.model,
          effort: effortOverrides.get(key) || config.effort,
          promptMode: config.promptMode,
          mode: config.mode,
          ptc: config.ptc,
          diagnosticsDir: config.diagnostics
            ? path.join(config.diagnosticsDir, taskId || `run_${Date.now()}`)
            : "",
          permission: config.permission,
          files: prepared.files,
          maxSteps: config.maxSteps,
          timeoutMs: config.timeoutMs,
          signal: controller.signal,
          onEvent,
        });
        if (!result.aborted && result.sessionID) {
          sessions.set(key, result.sessionID);
        }
        try {
          sessions.save();
        } catch (err) {
          logger?.error("保存会话状态失败", err);
        }
        const summary = withUsage(summarizeResult(result), result);
        recordResult(taskId, result, {
          userRequested: controller.userRequested === true,
          durationMs: Date.now() - startedAt,
        });
        const replyResult = await reply(message.messageId, summary, {
          progressMessageId,
          chatId: message.chatId,
        });
        await maybeNotifyCompletion(message, {
          summary,
          result,
          updatedProgress: replyResult.updatedProgress,
        });
        if (result.error || result.spawnError) await markFailure(message);
      } catch (err) {
        if (store && taskId) store.markFailed(taskId, { error: err?.message || String(err) });
        await markFailure(message);
        throw err;
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        await clearProcessing(message, reactionId);
        running.delete(key);
      }
    });

    run.catch((err) => logger?.error("任务执行异常", err));
    return run;
  }

  function startTask(task) {
    return startRun(taskToMessage(task), { key: task.sessionKey, task });
  }

  function abortAll() {
    for (const controller of running.values()) controller.abort();
    return running.size;
  }

  async function notifyCard(raw, { title, text, template }) {
    const card = buildProgressCard({ title, text, template });
    if (raw.token && typeof lark.updateCardByToken === "function") {
      try {
        const result = await lark.updateCardByToken(raw.token, card);
        if (result?.code === 0) return true;
      } catch (err) {
        logger?.debug?.("更新回调卡片失败", err?.message || String(err));
      }
    }
    if (raw.chat_id && typeof lark.sendText === "function") {
      try {
        await lark.sendText(raw.chat_id, text);
      } catch (err) {
        logger?.warn?.("发送卡片反馈失败", err?.message || String(err));
      }
    }
    return false;
  }

  async function handleCardAction(raw) {
    if (!raw || raw.type !== "card.action.trigger") return { status: "ignored" };
    let value = {};
    if (typeof raw.action_value === "string") {
      try {
        value = JSON.parse(raw.action_value);
      } catch {
        value = {};
      }
    } else if (raw.action_value && typeof raw.action_value === "object") {
      value = raw.action_value;
    }
    if (value.cmd !== "/stop") return { status: "ignored" };

    const key = String(value.key || "");
    const controller = running.get(key);
    if (!controller) {
      await notifyCard(raw, {
        title: "任务已结束",
        text: "这个任务已经结束，无需停止。",
        template: "grey",
      });
      return { status: "no-task" };
    }

    controller.userRequested = true;
    controller.abort();
    await notifyCard(raw, {
      title: "正在停止",
      text: "已发送停止信号，任务将终止。",
      template: "orange",
    });
    return { status: "stopped", key };
  }

  async function handle(rawEvent) {
    const message = normalizeEvent(rawEvent);
    if (!message) return { status: "ignored" };
    if (!seen.check(message.messageId)) return { status: "duplicate" };
    if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(message.chatId)) {
      logger?.debug("忽略不在白名单内的会话", message.chatId);
      return { status: "blocked", reason: "chat-not-allowed" };
    }

    const access = resolveAccess(message);
    if (!access.allowed) {
      logger?.debug("忽略无权访问的消息", message.chatId, access.reason);
      return { status: "blocked", reason: access.reason };
    }

    if (
      !isAddressedToBot(message, {
        botName: config.botName || "",
        requireMention: access.requireMention,
      })
    ) {
      return { status: "not-addressed" };
    }

    const command = parseCommand(message.text);
    if (command) {
      await handleCommand(command.command, message);
      return { status: "command", command: command.command };
    }
    if (message.text.startsWith("/")) {
      await reply(message.messageId, `未知命令：${message.text.split(/\s+/)[0]}\n\n${HELP_TEXT}`);
      return { status: "unknown-command" };
    }

    if (batcher && !isMediaMessage(message)) {
      batcher.add(sessionKeyFor(message), message);
      return { status: "batched" };
    }

    const run = startRun(message);
    return { status: "started", run };
  }

  handle.startRun = startRun;
  handle.startTask = startTask;
  handle.abortAll = abortAll;
  handle.cardAction = handleCardAction;
  return handle;
}
export async function recoverTasks({
  store,
  config,
  logger,
  submit,
  notifyInterrupted,
  now = Date.now(),
}) {
  if (!store) throw new Error("recoverTasks 需要 TaskStore");

  const interrupted = store.markRunningAsInterrupted({
    error: "进程重启中断",
    now,
  });
  if (interrupted > 0) {
    logger?.info?.(`已将 ${interrupted} 个残留执行中的任务标记为中断`);
  }

  let requeued = 0;
  const kept = [];
  for (const task of store.listByStatus("interrupted")) {
    if (config.taskAutoRetry && task.attempts < config.taskMaxAttempts) {
      if (store.requeue(task.id) > 0) {
        requeued += 1;
        continue;
      }
    }
    kept.push(task);
  }

  for (const task of kept) {
    if (typeof notifyInterrupted !== "function") continue;
    try {
      await notifyInterrupted(task, task.error || "进程重启中断");
    } catch (err) {
      logger?.warn?.(`通知中断任务失败: ${task.id}`, err?.message || String(err));
    }
  }

  const queued = store.listByStatus("queued");
  for (const task of queued) {
    submit(task);
  }

  return { interrupted, requeued, submitted: queued.length, kept: kept.length };
}

export function taskToMessage(task) {
  const meta = task && task.media && !Array.isArray(task.media) ? task.media : {};
  return {
    chatId: task.chatId,
    messageId: task.messageId,
    chatType: meta.chatType || "p2p",
    messageType: meta.messageType || "text",
    mediaType: meta.mediaType || "",
    text: meta.text || "",
    mentions: Array.isArray(meta.mentions) ? meta.mentions : [],
    senderId: meta.senderId || "",
  };
}

export function syncWorkspace(store, workdir, logger) {
  const previous = store.getMeta("workspace");
  if (previous && previous !== workdir) {
    const cleared = store.clearAllSessions();
    store.setMeta("workspace", workdir);
    logger?.warn?.(
      `工作目录已从 ${previous} 变为 ${workdir}，已清空 ${cleared} 个会话映射`,
    );
    return { changed: true, cleared, previous };
  }
  if (!previous) store.setMeta("workspace", workdir);
  return { changed: false, cleared: 0, previous };
}
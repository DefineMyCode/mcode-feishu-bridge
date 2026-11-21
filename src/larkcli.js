import { spawn as defaultSpawn } from "node:child_process";

const MAX_OUTPUT = 4000;

export function buildConsumeArgs({ eventKey = "im.message.receive_v1", identity = "bot" } = {}) {
  return ["event", "consume", eventKey, "--as", identity, "--quiet"];
}

export function buildReplyArgs({ messageId, text, identity = "bot", markdown = true }) {
  const contentFlag = markdown ? "--markdown" : "--text";
  return ["im", "+messages-reply", "--message-id", messageId, contentFlag, text, "--as", identity];
}

export function buildSendArgs({ chatId, text, identity = "bot" }) {
  return ["im", "+messages-send", "--chat-id", chatId, "--text", text, "--as", identity];
}

export function buildReplyCardArgs({ messageId, card, identity = "bot" }) {
  return [
    "im",
    "+messages-reply",
    "--message-id",
    messageId,
    "--content",
    card,
    "--msg-type",
    "interactive",
    "--as",
    identity,
  ];
}

export function buildReactionArgs({ messageId, emojiType, identity = "bot" }) {
  return [
    "im",
    "reactions",
    "create",
    "--message-id",
    messageId,
    "--data",
    JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
    "--as",
    identity,
  ];
}

export function buildReactionDeleteArgs({ messageId, reactionId, identity = "bot" }) {
  return [
    "im",
    "reactions",
    "delete",
    "--params",
    JSON.stringify({ message_id: messageId, reaction_id: reactionId }),
    "--as",
    identity,
  ];
}

export function buildSendFileArgs({ chatId, file, identity = "bot" }) {
  return ["im", "+messages-send", "--chat-id", chatId, "--file", file, "--as", identity];
}

export function buildSendMarkdownArgs({ chatId, text, identity = "bot" }) {
  return ["im", "+messages-send", "--chat-id", chatId, "--markdown", text, "--as", identity];
}

export function parseFloodWait(text) {
  const raw = String(text ?? "");
  if (!raw) return 0;
  const retry =
    raw.match(/retry[_\s-]?after["'\s:=]*([\d.]+)/i) ||
    raw.match(/([\d.]+)\s*秒(?:后|之后)/);
  if (retry) {
    const seconds = Number.parseFloat(retry[1]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 30;
  }
  if (/429|rate.?limit|flood|too many requests|频率超限|触发限流/i.test(raw)) return 30;
  return 0;
}

export function extractMessageId(result) {
  if (!result || result.code !== 0) return "";
  try {
    const body = JSON.parse(result.stdout || "");
    return body?.data?.message_id || body?.message_id || "";
  } catch {
    return "";
  }
}

export function createNdjsonDecoder(onObject, onBadLine = () => {}) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          onBadLine(line);
          continue;
        }
        onObject(value);
      }
    },
    flush() {
      const line = buffer.trim();
      buffer = "";
      if (!line) return;
      try {
        onObject(JSON.parse(line));
      } catch {
        onBadLine(line);
      }
    },
  };
}

export class LarkCli {
  constructor({
    bin = "lark-cli",
    identity = "bot",
    eventKey = "im.message.receive_v1",
    logger,
    spawnImpl = defaultSpawn,
    baseArgs = [],
  } = {}) {
    this.bin = bin;
    this.identity = identity;
    this.eventKey = eventKey;
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.baseArgs = baseArgs;
    this.consumer = null;
    this.stopped = false;
    this.restartDelay = 1000;
    this.floodUntil = 0;
  }

  isFlooded() {
    return Date.now() < this.floodUntil;
  }

  floodWaitMs() {
    return Math.max(0, this.floodUntil - Date.now());
  }

  async call(args, { timeoutMs = 120000, cwd } = {}) {
    return new Promise((resolve) => {
      const child = this.spawnImpl(this.bin, [...this.baseArgs, ...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      timer.unref?.();

      child.stdout.setEncoding?.("utf8");
      child.stdout.on("data", (d) => {
        stdout = (stdout + d).slice(-200000);
      });
      child.stderr.setEncoding?.("utf8");
      child.stderr.on("data", (d) => {
        stderr = (stderr + d).slice(-MAX_OUTPUT);
      });
      const done = (code, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const wait = parseFloodWait(`${stdout}\n${stderr}\n${error ?? ""}`);
          if (wait > 0) {
            this.floodUntil = Date.now() + wait * 1000;
            this.logger?.warn?.(`飞书限流，${wait}s 内跳过非关键发送`);
          }
        }
        resolve({ code, stdout, stderr, error });
      };
      child.on("error", (err) => done(null, err.message));
      child.on("close", (code) => done(code));
    });
  }

  async version() {
    const result = await this.call(["--version"], { timeoutMs: 20000 });
    return result.code === 0 ? result.stdout.trim() : "";
  }

  async status() {
    const result = await this.call(["whoami"], { timeoutMs: 20000 });
    if (result.code !== 0) return { ok: false, detail: (result.stderr || result.stdout).slice(0, 400) };
    try {
      return { ok: true, detail: JSON.parse(result.stdout) };
    } catch {
      return { ok: true, detail: result.stdout.trim() };
    }
  }

  async replyCard(messageId, card) {
    return this.call(buildReplyCardArgs({ messageId, card, identity: this.identity }));
  }

  async replyMarkdown(messageId, text) {
    return this.call(buildReplyArgs({ messageId, text, identity: this.identity }));
  }

  async replyText(messageId, text) {
    return this.call(buildReplyArgs({ messageId, text, identity: this.identity, markdown: false }));
  }

  async sendText(chatId, text) {
    return this.call(buildSendArgs({ chatId, text, identity: this.identity }));
  }

  async sendMarkdown(chatId, text) {
    return this.call(buildSendMarkdownArgs({ chatId, text, identity: this.identity }));
  }

  async sendFile(chatId, file, { cwd } = {}) {
    return this.call(buildSendFileArgs({ chatId, file, identity: this.identity }), {
      cwd,
      timeoutMs: 180000,
    });
  }

  async updateCard(messageId, card) {
    if (!messageId || !card) return { code: 1, error: "missing message id or card" };
    return this.call(
      [
        "api",
        "PATCH",
        `/open-apis/im/v1/messages/${messageId}`,
        "--data",
        JSON.stringify({ content: card }),
        "--as",
        this.identity,
      ],
      { timeoutMs: 30000 },
    );
  }

  async fetchMessageResources(messageId, { cwd } = {}) {
    if (!messageId) return [];
    const result = await this.call(
      [
        "im",
        "+messages-mget",
        "--message-ids",
        messageId,
        "--download-resources",
        "--as",
        this.identity,
      ],
      { timeoutMs: 60000, cwd },
    );
    if (result.code !== 0) {
      this.logger?.warn?.("下载消息资源失败", (result.stderr || "").slice(0, 200));
      return [];
    }
    try {
      const body = JSON.parse(result.stdout || "");
      const messages = body?.data?.messages || [];
      return messages
        .flatMap((item) => (Array.isArray(item.resources) ? item.resources : []))
        .filter((item) => item && item.local_path)
        .map((item) => ({
          key: item.key || "",
          localPath: item.local_path,
          sizeBytes: Number(item.size_bytes) || 0,
          type: item.type || "",
        }));
    } catch {
      return [];
    }
  }

  async fetchMessageDetail(messageId) {
    if (!messageId) return null;
    const result = await this.call(
      ["api", "GET", `/open-apis/im/v1/messages/${messageId}`, "--as", this.identity],
      { timeoutMs: 30000 },
    );
    if (result.code !== 0) {
      this.logger?.debug?.("读取消息详情失败", (result.stderr || "").slice(0, 200));
      return null;
    }
    try {
      const body = JSON.parse(result.stdout || "");
      const item = body?.data?.items?.[0];
      if (!item) return null;
      return {
        msgType: item.msg_type || "",
        content: item.body?.content || "",
      };
    } catch {
      return null;
    }
  }

  async downloadResource({ messageId, fileKey, type = "file", output, cwd } = {}) {
    if (!messageId || !fileKey) return null;
    const args = [
      "im",
      "+messages-resources-download",
      "--message-id",
      messageId,
      "--file-key",
      fileKey,
      "--type",
      type,
      "--as",
      this.identity,
    ];
    if (output) args.push("--output", output);
    const result = await this.call(args, { timeoutMs: 60000, cwd });
    if (result.code !== 0) {
      this.logger?.warn?.("下载附件失败", (result.stderr || "").slice(0, 200));
      return null;
    }
    try {
      const body = JSON.parse(result.stdout || "");
      const localPath = body?.data?.saved_path;
      if (!localPath) return null;
      return {
        localPath,
        sizeBytes: Number(body.data.size_bytes) || 0,
        type,
      };
    } catch {
      return null;
    }
  }

  async updateCardByToken(token, card) {
    if (!token || !card) return { code: 1, error: "missing token or card" };
    return this.call(
      [
        "api",
        "POST",
        "/open-apis/interactive/v1/card/update",
        "--data",
        JSON.stringify({ token, card: JSON.parse(card) }),
        "--as",
        this.identity,
      ],
      { timeoutMs: 30000 },
    );
  }

  async addReaction(messageId, emojiType) {
    if (!messageId || !emojiType) return "";
    const result = await this.call(
      buildReactionArgs({ messageId, emojiType, identity: this.identity }),
      { timeoutMs: 30000 },
    );
    if (result.code !== 0) {
      this.logger?.debug?.("添加表情失败", (result.stderr || "").slice(0, 200));
      return "";
    }
    try {
      const body = JSON.parse(result.stdout);
      return body?.data?.reaction_id || body?.reaction_id || "";
    } catch {
      return "";
    }
  }

  async removeReaction(messageId, reactionId) {
    if (!messageId || !reactionId) return false;
    const result = await this.call(
      buildReactionDeleteArgs({ messageId, reactionId, identity: this.identity }),
      { timeoutMs: 30000 },
    );
    if (result.code !== 0) {
      this.logger?.debug?.("移除表情失败", (result.stderr || "").slice(0, 200));
      return false;
    }
    return true;
  }

  isUnsubscribedError(detail) {
    const text = String(detail || "");
    if (text.includes("requires callbacks not subscribed")) return true;
    return text.includes("failed_precondition") && text.toLowerCase().includes("callback");
  }

  startConsuming({ onEvent, onFatal } = {}) {
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      const child = this.spawnImpl(
        this.bin,
        [...this.baseArgs, ...buildConsumeArgs({ eventKey: this.eventKey, identity: this.identity })],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      this.consumer = child;
      let stderrTail = "";

      const decoder = createNdjsonDecoder(
        (event) => {
          try {
            const maybe = onEvent?.(event);
            if (maybe && typeof maybe.catch === "function") {
              maybe.catch((err) => this.logger?.error("处理事件失败", err));
            }
          } catch (err) {
            this.logger?.error("处理事件失败", err);
          }
        },
        () => this.logger?.warn("事件流中出现非 JSON 行，已丢弃"),
      );

      child.stdout.setEncoding?.("utf8");
      child.stdout.on("data", (data) => decoder.push(data));
      child.stderr.setEncoding?.("utf8");
      child.stderr.on("data", (data) => {
        stderrTail = (stderrTail + data).slice(-MAX_OUTPUT);
        this.logger?.debug("lark-cli stderr", data.trim());
      });
      child.on("error", (err) => {
        this.logger?.error("无法启动 lark-cli event consume", err.message);
      });
      child.on("close", (code) => {
        this.consumer = null;
        if (this.stopped) return;
        const detail = stderrTail.trim();
        if (code !== 0) {
          this.logger?.error(
            `事件流退出 code=${code}${detail ? "：" + detail.slice(0, 1200) : "（lark-cli 未输出错误详情）"}`,
          );
          if (this.isUnsubscribedError(detail)) {
            this.stopped = true;
            this.logger?.error(
              `事件 ${this.eventKey} 的订阅前置条件未满足，已停止重连。请到飞书开发者后台 → 事件与回调 → 回调配置 添加 ${this.eventKey}，并发布新版本后重启桥接。`,
            );
            return;
          }
          if (!detail) {
            this.logger?.error(
              "排查建议：确认应用已开启 im.message.receive_v1 事件且已发布、具备机器人能力与 im:message.p2p_msg:readonly 权限、网络与 DNS 正常；可在终端手动执行 lark-cli event consume im.message.receive_v1 --as bot 复现",
            );
          }
        } else {
          this.logger?.warn(`事件流正常结束（code=0），${this.restartDelay}ms 后重连`);
        }
        if (onFatal && code !== 0 && this.restartDelay >= 30000) onFatal(detail);
        const delay = this.restartDelay;
        this.restartDelay = Math.min(this.restartDelay * 2, 30000);
        setTimeout(loop, delay).unref?.();
      });
      this.restartDelay = 1000;
    };
    loop();
    return {
      stop: () => {
        this.stopped = true;
        if (this.consumer) {
          this.consumer.kill("SIGTERM");
          const child = this.consumer;
          setTimeout(() => child.kill("SIGKILL"), 3000).unref?.();
        }
      },
    };
  }
}
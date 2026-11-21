import path from "node:path";
import { parseCronTasks } from "./scheduler.js";
import { PERMISSION_POLICIES, PROMPT_MODES } from "./mcode.js";

function int(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function list(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const REPLY_FORMATS = ["card", "post", "text"];
const GROUP_POLICIES = ["open", "allowlist", "disabled"];
const MODES = ["standard", "lightweight"];

function parseGroupRules(raw) {
  if (!raw || !String(raw).trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GROUP_RULES 必须是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GROUP_RULES 必须是 {chatId: rule} 形式的对象");
  }
  const rules = {};
  for (const [chatId, rule] of Object.entries(parsed)) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`GROUP_RULES 中 ${chatId} 的规则必须是对象`);
    }
    const policy = rule.policy ? String(rule.policy).toLowerCase() : "";
    if (policy && !GROUP_POLICIES.includes(policy)) {
      throw new Error(`GROUP_RULES 中 ${chatId} 的 policy 只能是 open、allowlist 或 disabled`);
    }
    rules[chatId] = {
      policy,
      allowlist: Array.isArray(rule.allowlist) ? rule.allowlist.map(String) : [],
      blacklist: Array.isArray(rule.blacklist) ? rule.blacklist.map(String) : [],
      requireMention: rule.requireMention === undefined ? undefined : Boolean(rule.requireMention),
    };
  }
  return rules;
}

export function loadConfig(env = process.env) {
  if (!env.MCODE_WORKDIR) {
    throw new Error("缺少必填环境变量: MCODE_WORKDIR（mcode 的工作目录）");
  }
  if (!env.TASK_DB) {
    throw new Error(
      "缺少必填环境变量: TASK_DB（必须是绝对路径，例如 /root/mcode-feishu-bridge/data/tasks.db）",
    );
  }
  if (!path.isAbsolute(env.TASK_DB)) {
    throw new Error(`TASK_DB 必须是绝对路径: ${env.TASK_DB}`);
  }

  const replyFormat = (env.REPLY_FORMAT || "card").toLowerCase();
  if (!REPLY_FORMATS.includes(replyFormat)) {
    throw new Error('REPLY_FORMAT 只能是 "card"、"post" 或 "text"');
  }

  const permission = (env.MCODE_PERMISSION || "smart").toLowerCase();
  if (!PERMISSION_POLICIES.includes(permission)) {
    throw new Error('MCODE_PERMISSION 只能是 "smart"、"full" 或 "off"');
  }

  const promptMode = (env.MCODE_PROMPT_MODE || "tui").toLowerCase();
  if (!PROMPT_MODES.includes(promptMode)) {
    throw new Error('MCODE_PROMPT_MODE 只能是 "tui"、"coding" 或 "work"');
  }

  const mode = (env.MCODE_MODE || "standard").toLowerCase();
  if (!MODES.includes(mode)) {
    throw new Error('MCODE_MODE 只能是 "standard" 或 "lightweight"');
  }

  const groupPolicy = (env.GROUP_POLICY || "open").toLowerCase();
  if (!GROUP_POLICIES.includes(groupPolicy)) {
    throw new Error('GROUP_POLICY 只能是 "open"、"allowlist" 或 "disabled"');
  }

  return {
    larkBin: env.LARK_CLI_BIN || "lark-cli",
    larkProfile: env.LARK_PROFILE || "",
    larkIdentity: env.LARK_IDENTITY || "bot",
    eventKey: env.LARK_EVENT_KEY || "im.message.receive_v1",
    botName: env.BOT_NAME || "",
    requireMentionInGroup: bool(env.GROUP_REQUIRE_MENTION, true),
    groupSessionsPerUser: bool(env.GROUP_SESSIONS_PER_USER, true),
    allowedUserIds: list(env.ALLOWED_USER_IDS),
    groupPolicy,
    groupRules: parseGroupRules(env.GROUP_RULES),

    mcodeBin: env.MCODE_BIN || "mcode",
    workdir: path.resolve(env.MCODE_WORKDIR),
    model: env.MCODE_MODEL || "",
    effort: env.MCODE_EFFORT || "",
    promptMode,
    mode,
    ptc: bool(env.MCODE_PTC, false),
    diagnostics: bool(env.MCODE_DIAGNOSTICS, true),
    diagnosticsDir: path.resolve(env.MCODE_DIAGNOSTICS_DIR || "./data/diagnostics"),
    permission,
    timeoutMs: int(env.MCODE_TIMEOUT_MS, 1800000),
    maxSteps: nonNegativeInt(env.MCODE_MAX_STEPS, 0),
    maxConcurrency: int(env.MCODE_MAX_CONCURRENCY, 2),

    allowedChatIds: list(env.ALLOWED_CHAT_IDS),
    stateFile: path.resolve(env.STATE_FILE || "./data/sessions.json"),
    dedupFile: path.resolve(env.DEDUP_FILE || "./data/seen.json"),
    dedupTtlMs: int(env.DEDUP_TTL_MS, 24 * 60 * 60 * 1000),
    dedupMax: int(env.DEDUP_MAX, 2048),
    textBatchDelayMs: int(env.TEXT_BATCH_DELAY_MS, 600),
    textBatchMaxMessages: int(env.TEXT_BATCH_MAX_MESSAGES, 8),
    textBatchMaxChars: int(env.TEXT_BATCH_MAX_CHARS, 4000),
    mediaEnabled: bool(env.BRIDGE_MEDIA, true),
    mediaDir: path.resolve(env.MEDIA_DIR || "./data/media"),
    mediaRetentionDays: nonNegativeInt(env.MEDIA_RETENTION_DAYS, 7),
    taskDb: path.resolve(env.TASK_DB),
    taskAutoRetry: bool(env.TASK_AUTO_RETRY, true),
    taskMaxAttempts: int(env.TASK_MAX_ATTEMPTS, 2),
    taskRetentionDays: nonNegativeInt(env.TASK_RETENTION_DAYS, 30),
    textInjectMaxBytes: int(env.TEXT_INJECT_MAX_BYTES, 102400),
    textInjectMaxChars: int(env.TEXT_INJECT_MAX_CHARS, 8000),
    reactions: bool(env.BRIDGE_REACTIONS, true),
    reactionProcessingEmoji: env.REACTION_PROCESSING || "Typing",
    reactionFailureEmoji: env.REACTION_FAILURE || "CrossMark",
    replyFormat,
    progressCard: bool(env.BRIDGE_PROGRESS_CARD, true),
    completionNotice: bool(env.BRIDGE_COMPLETION_NOTICE, true),
    replyChunkSize: int(env.REPLY_CHUNK_SIZE, 1800),
    replyMaxChunks: int(env.REPLY_MAX_CHUNKS, 4),
    heartbeatMinutes: nonNegativeInt(env.BRIDGE_HEARTBEAT_MINUTES, 5),
    progressIntervalMs: int(env.BRIDGE_PROGRESS_INTERVAL_MS, 5000),
    attachLongOutput: bool(env.BRIDGE_ATTACH_LONG_OUTPUT, true),
    outputDir: path.resolve(env.BRIDGE_OUTPUT_DIR || "./data/output"),
    cronTasks: parseCronTasks(env.CRON_TASKS || ""),
    ack: bool(env.BRIDGE_ACK, true),
    logLevel: (env.LOG_LEVEL || "info").toUpperCase(),
  };
}
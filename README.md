# mcode-feishu-bridge

把 [MiniMax Code CLI](https://github.com/MiniMax-AI/minimax-code)（`mcode`）接进飞书：在飞书里 @ 机器人发任务，桥接调用 `mcode exec`，把过程与结果用交互卡片呈现。

设计参考自 [codearts-feishu-bridge](https://github.com/Dcsgo/codearts-feishu-bridge)，但执行器、事件协议、会话与结果展示都是按 `mcode` 重写的，并利用了 `mcode` 独有的能力。

## 特性

- 交互卡片：任务执行中是一张卡片，完成后原位更新为结果，不再刷屏。
- 工具进度：解析 `mcode` 的 `tool_call` 事件，卡片实时显示“正在执行：搜索代码 / 修改文件 / 执行命令”。
- 用量回执：结果卡片附带模型名、输入/输出 token、耗时。
- 原生附件：图片、文件等附件通过 `mcode exec --file` 传入，而不是只把路径拼进提示词。
- 会话续接：用 `mcode` 的 `sessionId`（`mvs_...`）续接上下文。
- 会话级模型与强度：`/model`、`/effort` 只影响当前会话。
- 任务持久化：SQLite 记录任务生命周期，重启后排队任务继续，执行中的任务可重投。
- 停止按钮：卡片上的“停止任务”与 `/stop` 等价，且会终止整个进程组。
- 飞书侧能力沿用成熟实现：群内按人隔离、用户白名单、群策略、去重落盘、文本批处理、媒体下载与清理、定时任务。

## 架构

```
飞书 ──lark-cli event consume──> LarkCli ──> handler ──> TaskStore(SQLite)
                                                │
                                                ├── TaskQueue（并发 + 会话串行）
                                                ├── runMcp（spawn mcode exec --output-format stream-json）
                                                └── 卡片 / 文本回复 / 表情
```

模块职责与 `mcode exec` 的 JSONL 契约见 [docs/architecture.md](docs/architecture.md)。

## 环境要求

- Node.js >= 24（使用内置 `node:sqlite`）
- `lark-cli`（飞书官方 CLI）并完成应用配置与登录
- `mcode`（MiniMax Code CLI）并完成登录：`mcode login`
- 无 npm 依赖，不需要 `npm install`

## 配置

复制 `.env.example` 为 `.env`，至少填写：

```
MCODE_WORKDIR=/root/your-project
TASK_DB=/root/mcode-feishu-bridge/data/tasks.db
```

路径类配置一律写绝对路径。

关键配置：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MCODE_WORKDIR` | 必填 | mcode 的工作目录 |
| `TASK_DB` | 必填 | 任务库绝对路径 |
| `MCODE_BIN` | `mcode` | mcode 可执行文件 |
| `MCODE_PERMISSION` | `smart` | `smart` / `full` / `off` |
| `MCODE_MODEL` | 空 | 默认模型，形如 `provider/model` |
| `MCODE_EFFORT` | 空 | 默认推理强度 |
| `MCODE_PROMPT_MODE` | `tui` | `tui` / `coding` / `work` |
| `MCODE_TIMEOUT_MS` | `1800000` | 单任务超时 |
| `MCODE_MAX_STEPS` | `0` | 最大步数，0 表示不限制 |
| `GROUP_SESSIONS_PER_USER` | `true` | 群内按发言人隔离上下文 |
| `ALLOWED_CHAT_IDS` | 空 | 会话白名单 |
| `BRIDGE_PROGRESS_CARD` | `true` | 使用进度卡片原位更新 |
| `BRIDGE_COMPLETION_NOTICE` | `true` | 完成后补发提醒（原位更新不会触发通知） |

完整配置见 `.env.example`。

## 启动

```bash
node src/index.js
```

systemd 示例：

```ini
[Unit]
Description=mcode Feishu Bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/mcode-feishu-bridge
EnvironmentFile=/root/mcode-feishu-bridge/.env
ExecStart=/usr/bin/node /root/mcode-feishu-bridge/src/index.js
Restart=always
KillMode=mixed
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

## 使用

- 私聊直接发任务；群聊需要 @ 机器人。
- `/help` 查看命令。
- `/new` 清空当前会话上下文。
- `/stop` 或卡片按钮停止任务。
- `/status` 查看状态、会话、模型与推理强度。
- `/model minimax/MiniMax-M3.1-Flash` 切换本会话模型，`/model reset` 恢复默认。
- `/effort high` 切换本会话推理强度，`/effort reset` 恢复默认。
- `/init` 让 mcode 分析项目并生成 `AGENTS.md`。
- 直接发送图片或文件，桥接会下载并通过 `--file` 传给 mcode。

## 测试

```bash
npm test                    # 单元测试
./scripts/e2e-smoke.sh      # 端到端冒烟（假 lark-cli + 假 mcode）
./scripts/e2e-recovery.sh   # 任务执行中 kill -9，重启后重投
```

## 目录

```
src/
  index.js         启动、事件订阅、恢复、定时任务
  handler.js       消息处理、命令、任务生命周期、卡片
  mcode.js         mcode 执行器（参数、事件、终止、摘要）
  exec-events.js   mcode JSONL 事件解析与聚合
  larkcli.js       飞书 CLI 封装（事件、回复、卡片、媒体、表情）
  taskstore.js     SQLite：任务、会话、去重、迁移
  recovery.js      启动恢复与中断通知
  sessions.js      会话存储
  message.js       消息归一化与去重
  media.js         附件下载、文本注入、清理
  card.js          飞书卡片渲染
  text.js          长文本分段
  output.js        长结果落盘
  scheduler.js     cron 定时任务
  queue.js         并发与串行队列
  config.js        配置校验
  logger.js        日志
```

## 与 codearts 桥接的关系

两者共享飞书侧的实现思路与大部分模块，但执行器完全不同：

| 维度 | codearts-feishu-bridge | mcode-feishu-bridge |
|---|---|---|
| 执行器 | `codearts run --format json` | `mcode exec --output-format stream-json` |
| 事件粒度 | 文本 / 错误 | 文本、工具调用、turn、usage |
| 会话 ID | `ses_...` | `mvs_...` |
| 附件 | 路径拼进提示词 | `--file` 原生附件，同时保留路径 |
| 用量 | 无 | token、模型、耗时 |
| 模型切换 | 启动参数 | 会话级 `/model`、`/effort` |

## License

[MIT](LICENSE) © 2026 Dcsgo
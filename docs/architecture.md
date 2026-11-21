# 架构与协议

## 一、整体链路

1. `lark-cli event consume im.message.receive_v1` 输出 JSONL 事件。
2. `LarkCli` 解析事件，交给 `handler`。
3. `handler` 做归一化、去重、准入、会话键计算与命令分发。
4. 任务写入 `TaskStore`（SQLite），进入 `TaskQueue`。
5. `runMcp` 启动 `mcode exec --output-format stream-json`，逐行消费事件。
6. 进度与结果通过飞书卡片呈现；最终状态回写任务表。

## 二、mcode exec 契约

命令形态：

```
mcode exec --output-format stream-json --permission <smart|full|off> \
  [--session <id>] [--model <provider/model>] [--effort <level>] \
  [--prompt-mode <tui|coding|work>] [--file <path>...] \
  [--max-steps <n>] [--timeout <duration>] \
  --input - --input-format json
```

stdin 写入：

```json
{"prompt": "..."}
```

stdout 是 JSONL，`schemaVersion` 固定为 1，事件类型：

| 类型 | 说明 |
|---|---|
| `exec.started` | 执行开始 |
| `session.started` / `session.resumed` | 新建或续接会话 |
| `turn.started` | 一轮开始 |
| `item.started` / `item.updated` / `item.completed` | 条目事件，`item.type` 为 `agent_message`、`reasoning` 或 `tool_call` |
| `turn.completed` | 本轮成功，带 `model`、`usage`、`durationMs` |
| `turn.failed` | 本轮失败，带 `status` 与 `error` |
| `exec.completed` | 最终结果，`result.status` 为 `succeeded` / `failed` / `timeout` / `cancelled` / `limit_exceeded` |

`exec.result`（含 `output`、`sessionId`、`usage`、`model`、`durationMs`）是最终事实来源；`item.completed` 的 `agent_message.content` 作为兜底文本。

## 三、事件聚合

`exec-events.js` 维护一个状态对象：

- `messages`：已完成的 agent 消息
- `text`：`contentDelta` 累积
- `toolCalls`：工具调用记录
- `currentTool`：当前执行中的工具标签
- `usage` / `model` / `durationMs` / `status` / `error`

最终文本优先级：`exec.result.output` > 最后一条 `agent_message` > `contentDelta` 拼接。

## 四、终止语义

- 用户停止（`/stop` 或卡片按钮）：标记 `userRequested`，任务状态记为 `stopped` 终态，重启不重投。
- 服务关闭：`abortAll` 触发，任务状态记为 `interrupted`，重启按策略重投。
- 超时：桥接层 `MCODE_TIMEOUT_MS` 与 `mcode --timeout` 双重约束，状态记为 `failed`。
- 进程终止：以 `detached` 启动 mcode，通过负 PID 终止整个进程组，避免子进程残留。

## 五、任务状态机

```
queued -> running -> succeeded
                  -> failed
                  -> stopped（用户主动停止，终态）
                  -> interrupted（进程中断，可重投）
interrupted -> queued（未超过尝试上限）
```

SQLite schema 版本为 2，`tasks.status` 的 CHECK 约束包含 `stopped`。

## 六、启动恢复

1. 把所有 `running` 标记为 `interrupted`。
2. 对 `interrupted` 且 `attempts < TASK_MAX_ATTEMPTS` 的任务重新入队。
3. 其余保持 `interrupted`，更新原卡片或发送文本通知。
4. 按创建时间投递全部 `queued` 任务。
5. 恢复必须早于事件订阅启动。

## 七、飞书侧

- 进度卡片：任务开始发送，带停止按钮；工具事件按 `BRIDGE_PROGRESS_INTERVAL_MS` 节流更新。
- 结果：PATCH 同一张卡片；失败回退为普通消息。长结果分段，第一段更新卡片，其余发新消息。
- 完成提醒：卡片原位更新不会触发飞书通知，单段结果时补发一条短消息，可用 `BRIDGE_COMPLETION_NOTICE` 关闭。
- 附件：`messages-mget` 或原始消息 API 解析资源，`messages-resources-download` 下载到 `MEDIA_DIR`，再以 `--file` 传给 mcode；小文本文件同时注入提示词。

## 八、安全边界

- `MCODE_PERMISSION=full` 或 `off` 会跳过确认，必须配合 `ALLOWED_CHAT_IDS` 或 `ALLOWED_USER_IDS`。
- 任务在 `MCODE_WORKDIR` 内执行，不要指向包含敏感数据的目录。
- 桥接不保存模型凭证；凭证由 `mcode login` 管理在 `~/.minimax`。
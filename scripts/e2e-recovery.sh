#!/bin/sh
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/lark-cli" <<'EOF'
#!/bin/sh
case "$1" in
  --version) echo "lark-cli 9.9.9-e2e" ;;
  whoami) echo '{"identity":"bot","app_id":"cli_e2e"}' ;;
  event)
    echo '{"type":"im.message.receive_v1","chat_id":"oc_rec","chat_type":"p2p","message_id":"om_rec","message_type":"text","sender_type":"user","content":"恢复演练","mentions":[]}'
    sleep 10
    ;;
  im)
    echo "$@" >> "$REPLY_LOG"
    echo '{"code":0,"data":{"message_id":"om_bot_rec"}}'
    ;;
  api)
    echo "$@" >> "$REPLY_LOG"
    echo '{"code":0}'
    ;;
esac
EOF

cat > "$WORK/mcode" <<'EOF'
#!/bin/sh
cat > /dev/null
if [ -f "$SLOW_MARKER" ]; then sleep 30; fi
printf '%s\n' '{"schemaVersion":1,"sequence":1,"type":"exec.started","sessionId":"mvs_rec"}'
printf '%s\n' '{"schemaVersion":1,"sequence":2,"type":"item.completed","item":{"id":"i1","type":"agent_message","content":"RECOVERY-OK"}}'
printf '%s\n' '{"schemaVersion":1,"sequence":3,"type":"turn.completed","model":{"modelId":"MiniMax-M3.1-Flash"},"usage":{"inputTokens":10,"outputTokens":2},"durationMs":100}'
printf '%s\n' '{"schemaVersion":1,"sequence":4,"type":"exec.completed","result":{"status":"succeeded","output":"RECOVERY-OK","sessionId":"mvs_rec","usage":{"inputTokens":10,"outputTokens":2},"durationMs":100}}'
EOF

chmod +x "$WORK/lark-cli" "$WORK/mcode"

export LARK_CLI_BIN="$WORK/lark-cli"
export MCODE_BIN="$WORK/mcode"
export MCODE_WORKDIR="$ROOT"
export STATE_FILE="$WORK/sessions.json"
export DEDUP_FILE="$WORK/seen.json"
export TASK_DB="$WORK/tasks.db"
export REPLY_LOG="$WORK/replies.log"
export SLOW_MARKER="$WORK/slow"
export LOG_LEVEL=info

touch "$SLOW_MARKER"
node "$ROOT/src/index.js" > "$WORK/first.log" 2>&1 &
PID=$!

STATUS=""
i=0
while [ "$i" -lt 80 ]; do
  STATUS=$(node -e '
const { DatabaseSync } = require("node:sqlite");
try {
  const db = new DatabaseSync(process.argv[1]);
  const row = db.prepare("SELECT status FROM tasks ORDER BY created_at LIMIT 1").get();
  console.log(row ? row.status : "");
  db.close();
} catch {
  console.log("");
}
' "$WORK/tasks.db")
  [ "$STATUS" = "running" ] && break
  i=$((i + 1))
  sleep 0.1
done
[ "$STATUS" = "running" ] || {
  echo "任务未进入 running 状态"
  cat "$WORK/first.log"
  exit 1
}

kill -KILL "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
echo "第一次启动已被 kill -9，数据库中的任务状态：running"

rm -f "$SLOW_MARKER"

node "$ROOT/src/index.js" > "$WORK/second.log" 2>&1 &
PID2=$!
sleep 5
kill -TERM "$PID2" 2>/dev/null || true
wait "$PID2" 2>/dev/null || true

echo "--- 第二次启动日志 ---"
grep -E "启动恢复|桥接已启动|中断" "$WORK/second.log" || true
echo "--- 任务最终状态 ---"
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
const row = db.prepare("SELECT status, attempts, error FROM tasks ORDER BY created_at LIMIT 1").get();
if (!row) {
  console.error("任务记录不存在");
  process.exit(1);
}
console.log("状态:", row.status, "尝试次数:", row.attempts, "错误:", row.error || "无");
if (row.status !== "succeeded" || Number(row.attempts) !== 2) process.exit(1);
db.close();
' "$WORK/tasks.db"

grep -q "中断=1 重投=1 投递=1" "$WORK/second.log"
grep -q "RECOVERY-OK" "$WORK/replies.log"
echo "E2E RECOVERY PASS"
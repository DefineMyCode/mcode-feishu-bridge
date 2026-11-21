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
    echo '{"type":"im.message.receive_v1","chat_id":"oc_e2e","chat_type":"p2p","message_id":"om_e2e","message_type":"text","sender_type":"user","content":"跑个冒烟","mentions":[]}'
    sleep 10
    ;;
  im)
    echo "$@" >> "$REPLY_LOG"
    echo '{"code":0,"data":{"message_id":"om_bot_e2e"}}'
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
printf '%s\n' '{"schemaVersion":1,"sequence":1,"type":"exec.started","sessionId":"mvs_e2e"}'
printf '%s\n' '{"schemaVersion":1,"sequence":2,"type":"item.completed","item":{"id":"i1","type":"agent_message","content":"E2E-OK"}}'
printf '%s\n' '{"schemaVersion":1,"sequence":3,"type":"turn.completed","model":{"modelId":"MiniMax-M3.1-Flash"},"usage":{"inputTokens":10,"outputTokens":2},"durationMs":100}'
printf '%s\n' '{"schemaVersion":1,"sequence":4,"type":"exec.completed","result":{"status":"succeeded","output":"E2E-OK","sessionId":"mvs_e2e","model":{"modelId":"MiniMax-M3.1-Flash"},"usage":{"inputTokens":10,"outputTokens":2},"durationMs":100}}'
EOF

chmod +x "$WORK/lark-cli" "$WORK/mcode"

export LARK_CLI_BIN="$WORK/lark-cli"
export MCODE_BIN="$WORK/mcode"
export MCODE_WORKDIR="$ROOT"
export STATE_FILE="$WORK/sessions.json"
export DEDUP_FILE="$WORK/seen.json"
export TASK_DB="$WORK/tasks.db"
export REPLY_LOG="$WORK/replies.log"
export LOG_LEVEL=info

node "$ROOT/src/index.js" > "$WORK/stdout.log" 2>&1 &
PID=$!
sleep 3
kill -TERM "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true

echo "--- 桥接日志 ---"
cat "$WORK/stdout.log"
echo "--- 飞书调用 ---"
cat "$REPLY_LOG" 2>/dev/null || echo "(没有调用)"
echo "--- 会话与任务状态 ---"
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
const session = db.prepare("SELECT session_id FROM sessions WHERE session_key = ?").get("oc_e2e");
console.log("会话:", session ? session.session_id : "(未写入)");
const counts = db.prepare("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status").all();
console.log("任务:", counts.length ? counts.map((r) => `${r.status}=${r.c}`).join(", ") : "(无)");
db.close();
' "$WORK/tasks.db"

grep -q "msg-type interactive" "$WORK/replies.log"
grep -q "E2E-OK" "$WORK/replies.log"
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
const row = db.prepare("SELECT session_id FROM sessions WHERE session_key = ?").get("oc_e2e");
if (!row || row.session_id !== "mvs_e2e") {
  console.error("会话未写入数据库");
  process.exit(1);
}
const done = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = ?").get("succeeded");
if (Number(done.c) !== 1) {
  console.error("任务未记录为成功");
  process.exit(1);
}
db.close();
' "$WORK/tasks.db"
echo "E2E SMOKE PASS"
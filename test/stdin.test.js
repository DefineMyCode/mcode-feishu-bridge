import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { LarkCli } from "../src/larkcli.js";

function fakeLarkCli() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-lark-stdin-"));
  const file = path.join(dir, "lark-cli");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const stdin = process.stdin;
stdin.on("end", () => {
  process.stderr.write(JSON.stringify({ ok: false, identity: "bot", error: { type: "internal", subtype: "unknown", message: "context canceled" } }) + "\\n");
  process.exit(5);
});
stdin.resume();
process.stdout.write(JSON.stringify({ type: "im.message.receive_v1", message_id: "om_stdin" }) + "\\n");
setInterval(() => {}, 1000);
`,
  );
  fs.chmodSync(file, 0o755);
  return { file, dir };
}

test("事件流保持 stdin 打开，lark-cli 不会因 EOF 退出并重连", async () => {
  const { file, dir } = fakeLarkCli();
  let spawnCount = 0;
  const errors = [];
  const cli = new LarkCli({
    bin: file,
    spawnImpl: (...args) => {
      spawnCount += 1;
      return spawn(...args);
    },
    logger: {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: (msg) => errors.push(String(msg)),
    },
  });

  const events = [];
  const consumer = cli.startConsuming({ onEvent: (event) => events.push(event) });

  await new Promise((resolve) => setTimeout(resolve, 1600));

  assert.equal(events.length, 1, "应该收到一条事件");
  assert.equal(spawnCount, 1, "stdin 保持打开时不应触发重连");
  assert.equal(errors.length, 0, "不应出现 context canceled 错误");

  consumer.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.rmSync(dir, { recursive: true, force: true });
});
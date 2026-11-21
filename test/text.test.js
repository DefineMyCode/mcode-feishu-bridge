import assert from "node:assert/strict";
import test from "node:test";
import { chunkText, splitText } from "../src/text.js";

test("空内容返回占位提示", () => {
  assert.deepEqual(chunkText("", 100, 3), ["（码道没有返回内容）"]);
  assert.deepEqual(chunkText("   ", 100, 3), ["（码道没有返回内容）"]);
});

test("短内容只产生一个分段", () => {
  assert.deepEqual(chunkText("hello", 100, 3), ["hello"]);
});

test("优先在换行处切分", () => {
  const text = "a".repeat(60) + "\n" + "b".repeat(60);
  const chunks = chunkText(text, 100, 3);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "a".repeat(60));
  assert.equal(chunks[1], "b".repeat(60));
});

test("超过最大段数时给出截断提示", () => {
  const chunks = chunkText("x".repeat(500), 100, 2);
  assert.equal(chunks.length, 2);
  assert.match(chunks[1], /已截断/);
  assert.ok(chunks[1].length <= 100);
});

test("多段内容保持顺序且不丢字", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
  const chunks = chunkText(lines.join("\n"), 30, 10);
  assert.equal(chunks.join("\n"), lines.join("\n"));
});

test("代码块被拆分时每段围栏都闭合", () => {
  const code = "```bash\n" + Array.from({ length: 80 }, (_, i) => `echo line-${i}`).join("\n") + "\n```";
  const text = `前言\n\n${code}\n\n结尾`;
  const chunks = chunkText(text, 300, 6);

  for (const chunk of chunks) {
    const fences = (chunk.match(/```/g) || []).length;
    assert.ok(fences === 0 || fences === 2, `未闭合围栏数=${fences}: ${chunk.slice(0, 40)}`);
  }
  assert.ok(chunks.length >= 3);
});

test("拆分后的代码块保留语言标记", () => {
  const code = "```python\n" + Array.from({ length: 60 }, (_, i) => `print(${i})`).join("\n") + "\n```";
  const chunks = chunkText(`说明\n\n${code}`, 200, 6);
  const codeChunks = chunks.filter((c) => c.includes("print("));

  assert.ok(codeChunks.length >= 2);
  for (const chunk of codeChunks) {
    assert.match(chunk, /^```python/);
    assert.match(chunk, /```$/);
  }
});

test("标题与表格不被空行切碎", () => {
  const text = "## 标题\n\n| 命令 | 作用 |\n|---|---|\n| /models | 选模型 |";
  const chunks = chunkText(text, 200, 3);

  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /^## 标题/);
  assert.match(chunks[0], /\| 命令 \| 作用 \|/);
});

test("表格作为整块合并，不会被空行拆成两段", () => {
  const table = "| 名称 | 说明 |\n|---|---|\n| a | 1 |";
  const text = `前言\n\n${table}`;
  const chunks = chunkText(text, 200, 5);

  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].includes(table));
});

test("表格内部空行不打断表格块", () => {
  const table = "| a | b |\n|---|---|\n| 1 | 2 |\n\n| 3 | 4 |";
  const chunks = chunkText(table, 500, 5);

  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /\| 3 \| 4 \|/);
});

test("长表格按行切分时行序不丢失", () => {
  const rows = Array.from({ length: 40 }, (_, i) => `| ${i} | 值${i} |`);
  const table = "| 序号 | 值 |\n|---|---|\n" + rows.join("\n");
  const chunks = chunkText(table, 200, 20);

  assert.ok(chunks.every((chunk) => chunk.length <= 200));
  const joined = chunks.join("\n");
  assert.ok(joined.includes("| 序号 | 值 |"));
  assert.ok(joined.includes("| 39 | 值39 |"));
});

test("列表块不被拆到标题所在分段之外", () => {
  const text = "## 用法\n\n- 第一项\n- 第二项\n- 第三项";
  const chunks = chunkText(text, 200, 3);

  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /- 第一项/);
  assert.match(chunks[0], /- 第三项/);
});

test("splitText 报告截断状态与总长度", () => {
  const long = Array.from({ length: 50 }, (_, i) => `段落-${i}`).join("\n\n");
  const result = splitText(long, 20, 2);

  assert.equal(result.truncated, true);
  assert.equal(result.chunks.length, 2);
  assert.equal(result.totalLength, long.length);

  const short = splitText("hi", 20, 2);
  assert.equal(short.truncated, false);
  assert.equal(short.totalLength, 2);
});
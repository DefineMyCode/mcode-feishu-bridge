import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isMediaMessage,
  isTextResource,
  readTextResource,
  buildResourceNote,
  composePrompt,
  extractResources,
  cleanMediaDir,
} from "../src/media.js";

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

test("识别媒体消息类型", () => {
  assert.equal(isMediaMessage({ mediaType: "image" }), true);
  assert.equal(isMediaMessage({ mediaType: "file" }), true);
  assert.equal(isMediaMessage({ mediaType: "audio" }), true);
  assert.equal(isMediaMessage({ mediaType: "media" }), true);
  assert.equal(isMediaMessage({ mediaType: "" }), false);
  assert.equal(isMediaMessage(null), false);
});

test("按扩展名判断文本资源", () => {
  assert.equal(isTextResource({ localPath: "/tmp/a.txt" }), true);
  assert.equal(isTextResource({ localPath: "/tmp/a.md" }), true);
  assert.equal(isTextResource({ localPath: "/tmp/a.png" }), false);
  assert.equal(isTextResource({ localPath: "" }), false);
});

test("读取小文本文件", () => {
  const file = tmpFile("a.txt", "hello");
  assert.equal(readTextResource({ localPath: file }), "hello");
});

test("超过字节上限时不注入内容", () => {
  const file = tmpFile("big.txt", "x".repeat(200));
  assert.equal(readTextResource({ localPath: file }, { maxBytes: 100 }), "");
});

test("超过字符上限时截断", () => {
  const file = tmpFile("long.txt", "abcdef");
  assert.equal(readTextResource({ localPath: file }, { maxChars: 3 }), "abc");
});

test("文件不存在时返回空字符串", () => {
  assert.equal(readTextResource({ localPath: "/tmp/not-exist-media-file" }), "");
});

test("资源说明包含图片路径且不内联图片内容", () => {
  const note = buildResourceNote([{ type: "image", localPath: "/tmp/x.png" }]);
  assert.match(note, /【用户附带资源】/);
  assert.match(note, /图片：\/tmp\/x\.png/);
  assert.doesNotMatch(note, /文件内容如下/);
});

test("文本文件内容被注入到说明中", () => {
  const file = tmpFile("note.md", "# 标题");
  const note = buildResourceNote([{ type: "file", localPath: file }]);
  assert.match(note, /文件内容如下/);
  assert.match(note, /# 标题/);
});

test("组合提示词保留原文并追加资源说明", () => {
  const file = tmpFile("a.txt", "content");
  const prompt = composePrompt("看下这个", [{ type: "file", localPath: file }]);
  assert.match(prompt, /^看下这个/);
  assert.match(prompt, /【用户附带资源】/);
  assert.match(prompt, /content/);
});

test("没有原文时仅返回资源说明", () => {
  const prompt = composePrompt("", [{ type: "image", localPath: "/tmp/y.png" }]);
  assert.match(prompt, /【用户附带资源】/);
});

test("没有资源时返回原文或兜底提示", () => {
  assert.equal(composePrompt("原文", []), "原文");
  assert.equal(composePrompt("", []), "请查看随消息附带的资源。");
});

test("解析富文本里的文件列表", () => {
  const resources = extractResources(
    JSON.stringify({ files: [{ file_key: "file_1", file_name: "a.txt" }] }),
  );
  assert.deepEqual(resources, [{ fileKey: "file_1", fileName: "a.txt", type: "file" }]);
});

test("解析图片与媒体节点并去重", () => {
  const resources = extractResources(
    JSON.stringify({
      image_key: "img_1",
      content: [[{ tag: "img", image_key: "img_1" }, { tag: "media", file_key: "file_2" }]],
    }),
  );
  assert.equal(resources.length, 2);
  assert.deepEqual(resources.map((r) => r.fileKey), ["img_1", "file_2"]);
});

test("非法内容返回空数组", () => {
  assert.deepEqual(extractResources("not json"), []);
  assert.deepEqual(extractResources(null), []);
  assert.deepEqual(extractResources({}), []);
});

test("清理超过保留期的附件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-clean-"));
  const oldFile = path.join(dir, "old.txt");
  const newFile = path.join(dir, "new.txt");
  fs.writeFileSync(oldFile, "old", "utf8");
  fs.writeFileSync(newFile, "new", "utf8");
  const now = Date.now();
  const old = new Date(now - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, old, old);

  const result = cleanMediaDir(dir, { retentionMs: 7 * 24 * 60 * 60 * 1000, now: () => now });
  assert.equal(result.removed, 1);
  assert.equal(result.kept, 1);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(newFile), true);
});

test("保留期为 0 时不清理", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-clean-"));
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "a", "utf8");
  const result = cleanMediaDir(dir, { retentionMs: 0 });
  assert.equal(result.removed, 0);
  assert.equal(fs.existsSync(file), true);
});

test("目录不存在时返回零结果", () => {
  const result = cleanMediaDir("/tmp/not-exist-media-dir-probe", { retentionMs: 1000 });
  assert.deepEqual(result, { removed: 0, kept: 0 });
});

test("清理时跳过子目录", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-clean-"));
  fs.mkdirSync(path.join(dir, "sub"));
  const result = cleanMediaDir(dir, { retentionMs: 1, now: () => Date.now() + 10000 });
  assert.equal(result.removed, 0);
});
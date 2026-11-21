import fs from "node:fs";
import path from "node:path";

export const MEDIA_TYPES = ["image", "file", "audio", "media"];

export const TEXT_RESOURCE_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".jsonl",
  ".log",
  ".yml",
  ".yaml",
];

export function isMediaMessage(message) {
  return Boolean(message && MEDIA_TYPES.includes(message.mediaType));
}

export function isTextResource(resource) {
  const ext = path.extname(String(resource?.localPath || "")).toLowerCase();
  return TEXT_RESOURCE_EXTENSIONS.includes(ext);
}

export function readTextResource(resource, { maxBytes = 102400, maxChars = 8000 } = {}) {
  try {
    const stat = fs.statSync(resource.localPath);
    if (!stat.isFile() || stat.size > maxBytes) return "";
    return fs.readFileSync(resource.localPath, "utf8").slice(0, maxChars);
  } catch {
    return "";
  }
}

export function buildResourceNote(resources = [], { maxBytes, maxChars } = {}) {
  if (!Array.isArray(resources) || resources.length === 0) return "";
  const lines = ["", "【用户附带资源】"];
  for (const resource of resources) {
    const label =
      resource.type === "image" ? "图片" : resource.type === "file" ? "文件" : resource.type || "附件";
    lines.push(`- ${label}：${resource.localPath}`);
    if (isTextResource(resource)) {
      const content = readTextResource(resource, { maxBytes, maxChars });
      if (content) {
        lines.push("  文件内容如下：");
        lines.push("```");
        lines.push(content);
        lines.push("```");
      }
    }
  }
  return lines.join("\n");
}

export function composePrompt(text, resources, options = {}) {
  const note = buildResourceNote(resources, options);
  const base = String(text || "").trim();
  if (!note) return base || "请查看随消息附带的资源。";
  return base ? `${base}\n${note}` : note.trim();
}

export function extractResources(content) {
  let body = content;
  if (typeof content === "string") {
    try {
      body = JSON.parse(content);
    } catch {
      return [];
    }
  }
  if (!body || typeof body !== "object") return [];

  const found = [];
  if (Array.isArray(body.files)) {
    for (const item of body.files) {
      if (item && item.file_key) {
        found.push({ fileKey: item.file_key, fileName: item.file_name || "", type: "file" });
      }
    }
  }
  if (body.image_key) found.push({ fileKey: body.image_key, fileName: "", type: "image" });
  if (body.file_key) {
    found.push({ fileKey: body.file_key, fileName: body.file_name || "", type: "file" });
  }
  for (const key of ["content", "content_v2"]) {
    const rows = Array.isArray(body[key]) ? body[key] : [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      for (const element of row) {
        if (!element || typeof element !== "object") continue;
        if (element.tag === "img" && element.image_key) {
          found.push({ fileKey: element.image_key, fileName: "", type: "image" });
        }
        if (element.tag === "media" && element.file_key) {
          found.push({
            fileKey: element.file_key,
            fileName: element.file_name || "",
            type: "file",
          });
        }
      }
    }
  }

  const unique = new Map();
  for (const item of found) {
    if (!unique.has(item.fileKey)) unique.set(item.fileKey, item);
  }
  return [...unique.values()];
}

export function cleanMediaDir(
  dir,
  { retentionMs = 7 * 24 * 60 * 60 * 1000, now = () => Date.now(), logger } = {},
) {
  if (!dir || !retentionMs || retentionMs <= 0) return { removed: 0, kept: 0 };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT") logger?.warn?.(`读取附件目录失败: ${dir}`);
    return { removed: 0, kept: 0 };
  }

  const cutoff = now() - retentionMs;
  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      } else {
        kept += 1;
      }
    } catch {
      // 单个文件删除失败不影响其余文件
    }
  }
  return { removed, kept };
}
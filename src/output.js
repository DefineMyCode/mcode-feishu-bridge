import fs from "node:fs";
import path from "node:path";

function pad(value) {
  return String(value).padStart(2, "0");
}

export function saveOutput({ dir, key = "task", text, now = new Date() }) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "task";
  const name = `${safeKey}_${stamp}.md`;
  const fullPath = path.join(dir, name);
  fs.writeFileSync(fullPath, String(text ?? ""), "utf8");
  return { path: fullPath, name };
}
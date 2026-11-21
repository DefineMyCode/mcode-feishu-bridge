function parseFenceLine(line) {
  const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  return { marker: match[1], lang: (match[2] || "").trim() };
}

function parseHeadingLine(line) {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
  if (!match) return null;
  return { level: match[1].length, text: match[2].trim() };
}

function isHrLine(line) {
  return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function isTableLine(line) {
  return line.includes("|") && line.trim().split("|").length >= 3 && parseTableRow(line) !== null;
}

function isListLine(line) {
  return /^\s{0,3}(?:[-*+]|\d+\.)\s+/.test(line);
}

function parseTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  let inner = trimmed;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  return inner.split("|").map((cell) => cell.trim());
}

function isTableSeparator(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")));
}

function parseBlocks(markdown) {
  const lines = markdown.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = parseFenceLine(line);
    if (fence) {
      const buffer = [line];
      i += 1;
      while (i < lines.length) {
        buffer.push(lines[i]);
        const closing = parseFenceLine(lines[i]);
        i += 1;
        if (closing && closing.marker[0] === fence.marker[0] && !closing.lang) break;
      }
      blocks.push({ type: "code", content: buffer.join("\n") });
      continue;
    }

    if (isTableLine(line)) {
      const rows = [];
      while (i < lines.length) {
        if (isTableLine(lines[i])) {
          const cells = parseTableRow(lines[i]);
          if (!isTableSeparator(cells)) rows.push(cells);
          i += 1;
          continue;
        }
        if (!lines[i].trim() && i + 1 < lines.length && isTableLine(lines[i + 1])) {
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "table", rows });
      continue;
    }

    const heading = parseHeadingLine(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading.level, text: heading.text });
      i += 1;
      continue;
    }

    if (isHrLine(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (isListLine(line)) {
      const buffer = [line];
      i += 1;
      while (i < lines.length && isListLine(lines[i])) {
        buffer.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "markdown", content: buffer.join("\n") });
      continue;
    }

    const buffer = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !parseFenceLine(lines[i]) &&
      !isTableLine(lines[i]) &&
      !parseHeadingLine(lines[i]) &&
      !isHrLine(lines[i]) &&
      !isListLine(lines[i])
    ) {
      buffer.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "markdown", content: buffer.join("\n") });
  }
  return blocks;
}

function rowToColumnSet(cells, isHeader) {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "default",
    columns: cells.map((cell) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "top",
      elements: [
        {
          tag: "markdown",
          content: isHeader ? `**${cell || " "}**` : cell || " ",
        },
      ],
    })),
  };
}

export function buildCardMarkdown(markdown, { wide = true } = {}) {
  const text = String(markdown ?? "");
  const blocks = parseBlocks(text);
  const elements = [];
  let header = null;

  blocks.forEach((block, index) => {
    if (block.type === "heading") {
      if (index === 0) {
        header = { title: { tag: "plain_text", content: block.text || " " } };
      } else {
        elements.push({ tag: "markdown", content: `**${block.text}**` });
      }
      return;
    }
    if (block.type === "code") {
      elements.push({ tag: "markdown", content: block.content });
      return;
    }
    if (block.type === "hr") {
      elements.push({ tag: "hr" });
      return;
    }
    if (block.type === "table") {
      block.rows.forEach((cells, rowIndex) => {
        elements.push(rowToColumnSet(cells, rowIndex === 0));
      });
      return;
    }
    elements.push({ tag: "markdown", content: block.content });
  });

  if (elements.length === 0) {
    elements.push({ tag: "markdown", content: "" });
  }

  const card = {
    config: {
      wide_screen_mode: wide,
      update_multi: true,
    },
    elements,
  };
  if (header) card.header = header;
  return JSON.stringify(card);
}

export function buildProgressCard({
  title = "任务执行中",
  text = "任务执行中…（发送 /stop 可终止）",
  template = "blue",
  actions = [],
} = {}) {
  const elements = [{ tag: "markdown", content: text }];
  if (Array.isArray(actions) && actions.length > 0) {
    elements.push({
      tag: "action",
      layout: "bisected",
      actions: actions.map((item) => ({
        tag: "button",
        text: { tag: "plain_text", content: item.text || "操作" },
        type: item.type || "default",
        value: item.value || {},
      })),
    });
  }
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: "plain_text", content: title }, template },
    elements,
  });
}
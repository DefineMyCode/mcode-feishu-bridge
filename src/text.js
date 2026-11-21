function parseFence(line) {
  const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  return { marker: match[1], lang: (match[2] || "").trim() };
}

function isHrLine(line) {
  return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function isTableLine(line) {
  return /\|/.test(line) && line.trim().split("|").length >= 3;
}

function isHeadingLine(line) {
  return /^\s{0,3}#{1,6}\s+/.test(line);
}

function isListLine(line) {
  return /^\s{0,3}(?:[-*+]|\d+\.)\s+/.test(line);
}

function splitBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = parseFence(line);
    if (fence) {
      const buffer = [line];
      i += 1;
      while (i < lines.length) {
        buffer.push(lines[i]);
        const closing = parseFence(lines[i]);
        i += 1;
        if (closing && closing.marker[0] === fence.marker[0] && !closing.lang) break;
      }
      blocks.push(buffer.join("\n"));
      continue;
    }

    if (isTableLine(line)) {
      const buffer = [line];
      i += 1;
      while (i < lines.length) {
        if (isTableLine(lines[i])) {
          buffer.push(lines[i]);
          i += 1;
          continue;
        }
        if (!lines[i].trim() && i + 1 < lines.length && isTableLine(lines[i + 1])) {
          buffer.push("");
          i += 1;
          continue;
        }
        break;
      }
      blocks.push(buffer.join("\n"));
      continue;
    }

    if (isHeadingLine(line)) {
      blocks.push(line);
      i += 1;
      continue;
    }

    if (isHrLine(line)) {
      blocks.push(line);
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
      blocks.push(buffer.join("\n"));
      continue;
    }

    const buffer = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !parseFence(lines[i]) &&
      !isTableLine(lines[i]) &&
      !isHeadingLine(lines[i]) &&
      !isHrLine(lines[i]) &&
      !isListLine(lines[i])
    ) {
      buffer.push(lines[i]);
      i += 1;
    }
    blocks.push(buffer.join("\n"));
  }
  return blocks;
}

function splitLongParagraph(paragraph, size) {
  const lines = paragraph.split("\n");
  const pieces = [];
  let buffer = [];
  let bufferLength = 0;
  let fence = null;

  const flush = () => {
    if (buffer.length > 0) {
      pieces.push(buffer.join("\n"));
      buffer = [];
      bufferLength = 0;
    }
  };

  for (const line of lines) {
    if (buffer.length === 0 && line.length + 1 > size) {
      for (let i = 0; i < line.length; i += size) {
        pieces.push(line.slice(i, i + size));
      }
      continue;
    }

    if (buffer.length > 0 && bufferLength + line.length + 1 > size) {
      if (fence) {
        buffer.push(fence.marker);
        flush();
        buffer = [fence.marker + fence.lang];
        bufferLength = buffer[0].length + 1;
      } else {
        flush();
      }
    }

    buffer.push(line);
    bufferLength += line.length + 1;

    const current = parseFence(line);
    if (current) {
      if (!fence) fence = current;
      else if (current.marker[0] === fence.marker[0] && !current.lang) fence = null;
    }
  }

  flush();
  return pieces;
}

export function splitText(text, size, maxChunks) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return { chunks: ["（码道没有返回内容）"], truncated: false, totalLength: 0 };
  }

  const blocks = splitBlocks(normalized);
  const chunks = [];
  let current = "";

  const flushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= size) {
      current = candidate;
      continue;
    }

    flushCurrent();

    if (block.length <= size) {
      current = block;
      continue;
    }

    for (const piece of splitLongParagraph(block, size)) {
      const merged = current ? `${current}\n\n${piece}` : piece;
      if (merged.length <= size) current = merged;
      else {
        flushCurrent();
        chunks.push(piece);
      }
    }
  }
  flushCurrent();

  const totalLength = normalized.length;
  if (chunks.length <= maxChunks) {
    return { chunks, truncated: false, totalLength };
  }

  const kept = chunks.slice(0, maxChunks);
  const restLength = chunks.slice(maxChunks).join("\n\n").length;
  const note = `\n\n…（内容过长，已截断，剩余 ${restLength} 字符）`;
  const last = kept[kept.length - 1];
  kept[kept.length - 1] = last.slice(0, Math.max(0, size - note.length)) + note;
  return { chunks: kept, truncated: true, totalLength };
}

export function chunkText(text, size, maxChunks) {
  return splitText(text, size, maxChunks).chunks;
}
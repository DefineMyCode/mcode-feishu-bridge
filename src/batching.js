export class TextBatcher {
  constructor({
    delayMs = 600,
    maxMessages = 8,
    maxChars = 4000,
    onFlush = () => {},
    timers = { setTimeout, clearTimeout },
  } = {}) {
    this.delayMs = Math.max(0, delayMs);
    this.maxMessages = Math.max(1, maxMessages);
    this.maxChars = Math.max(1, maxChars);
    this.onFlush = onFlush;
    this.timers = timers;
    this.buckets = new Map();
  }

  add(key, message) {
    if (!key || !message) return null;
    let bucket = this.buckets.get(key);
    const incoming = String(message.text || "");
    if (
      bucket &&
      (bucket.messages.length >= this.maxMessages ||
        bucket.chars + incoming.length > this.maxChars)
    ) {
      this.flush(key);
      bucket = null;
    }
    if (!bucket) {
      bucket = { messages: [], chars: 0, timer: null };
      this.buckets.set(key, bucket);
    }
    bucket.messages.push(message);
    bucket.chars += incoming.length;
    if (bucket.timer) this.timers.clearTimeout(bucket.timer);
    bucket.timer = this.timers.setTimeout(() => this.flush(key), this.delayMs);
    bucket.timer?.unref?.();
    return bucket.messages.length;
  }

  flush(key) {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    this.buckets.delete(key);
    if (bucket.timer) this.timers.clearTimeout(bucket.timer);
    const merged = mergeMessages(bucket.messages);
    if (merged) this.onFlush(merged, key);
    return merged;
  }

  flushAll() {
    const keys = [...this.buckets.keys()];
    const flushed = [];
    for (const key of keys) {
      const merged = this.flush(key);
      if (merged) flushed.push(merged);
    }
    return flushed;
  }

  stop() {
    for (const bucket of this.buckets.values()) {
      if (bucket.timer) this.timers.clearTimeout(bucket.timer);
    }
    this.buckets.clear();
  }

  size() {
    return this.buckets.size;
  }
}

export function mergeMessages(messages) {
  if (!messages || messages.length === 0) return null;
  if (messages.length === 1) return messages[0];
  const last = messages.at(-1);
  const mentions = messages.flatMap((m) => m.mentions || []);
  return {
    ...last,
    text: messages
      .map((m) => String(m.text || "").trim())
      .filter(Boolean)
      .join("\n\n"),
    mentions,
    batchedCount: messages.length,
  };
}
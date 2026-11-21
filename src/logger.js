const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export function createLogger({ level = "INFO", stream = process.stderr, now = () => new Date() } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.INFO;

  const write = (name, args) => {
    if (LEVELS[name] < threshold) return;
    const text = args
      .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
      .join(" ");
    stream.write(`${now().toISOString()} ${name} ${text}\n`);
  };

  return {
    debug: (...args) => write("DEBUG", args),
    info: (...args) => write("INFO", args),
    warn: (...args) => write("WARN", args),
    error: (...args) => write("ERROR", args),
  };
}
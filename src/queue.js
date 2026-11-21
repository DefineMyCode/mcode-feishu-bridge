export class TaskQueue {
  constructor({ maxConcurrency = 2 } = {}) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.active = 0;
    this.waiters = [];
    this.chains = new Map();
  }

  async acquire() {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }

  async runExclusive(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  push(key, fn) {
    const previous = this.chains.get(key) || Promise.resolve();
    const run = previous.then(
      () => this.runExclusive(fn),
      () => this.runExclusive(fn),
    );
    const tail = run.catch(() => {});
    this.chains.set(key, tail);
    tail.finally(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  isBusy(key) {
    return this.chains.has(key);
  }

  get pending() {
    return this.chains.size;
  }
}
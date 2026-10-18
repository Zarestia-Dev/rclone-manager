/** Keyed background work. Every refill yields to rendering; failures release their slot. */
export class DeferredTaskQueue {
  private readonly pending = new Map<string, () => Promise<unknown>>();
  private readonly active = new Map<string, { started: boolean; cancelled: boolean }>();
  private timer?: ReturnType<typeof setTimeout>;
  private destroyed = false;

  constructor(private readonly concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Concurrency must be a positive integer');
    }
  }

  enqueue(key: string, task: () => Promise<unknown>): void {
    if (this.destroyed) return;
    this.pending.set(key, task);
    this.schedule();
  }

  clear(key?: string): void {
    if (key !== undefined) this.pending.delete(key);
    else this.pending.clear();
    for (const [activeKey, task] of this.active) {
      if (!task.started && (key === undefined || activeKey === key)) task.cancelled = true;
    }
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.clear();
  }

  private schedule(): void {
    if (this.destroyed || this.timer !== undefined || this.active.size >= this.concurrency) return;
    if (!this.pending.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const [key, task] of this.pending) {
        if (this.active.size >= this.concurrency) break;
        if (this.active.has(key)) continue;
        this.pending.delete(key);
        const active = { started: false, cancelled: false };
        this.active.set(key, active);
        const finish = (): void => {
          this.active.delete(key);
          this.schedule();
        };
        // Owners publish errors in their own state. A failed task must not stall the queue.
        void Promise.resolve()
          .then(() => {
            if (this.destroyed || active.cancelled) return;
            active.started = true;
            return task();
          })
          .then(finish, finish);
      }
    }, 0);
  }
}

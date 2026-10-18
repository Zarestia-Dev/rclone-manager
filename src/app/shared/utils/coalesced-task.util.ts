/** Serial refreshes: concurrent requests share a promise and request one trailing run. */
export class CoalescedTask {
  private pending?: Promise<void>;
  private requested = false;

  constructor(private readonly refresh: () => Promise<void>) {}

  run(): Promise<void> {
    this.requested = true;
    if (this.pending) return this.pending;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.pending = pending;
    void this.drain().then(resolve, reject);
    return pending;
  }

  private async drain(): Promise<void> {
    try {
      do {
        this.requested = false;
        await this.refresh();
      } while (this.requested);
    } finally {
      this.pending = undefined;
    }
  }
}

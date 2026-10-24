import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeferredTaskQueue } from './deferred-task-queue.util';

describe('DeferredTaskQueue', () => {
  let queue: DeferredTaskQueue;
  beforeEach(() => {
    vi.useFakeTimers();
    queue = new DeferredTaskQueue(2);
  });
  afterEach(() => {
    queue.destroy();
    vi.useRealTimers();
  });

  it('defers work, deduplicates keys and refills individual slots', async () => {
    let finish!: () => void;
    const slow = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    const replaced = vi.fn().mockResolvedValue(undefined);
    const fast = vi.fn().mockResolvedValue(undefined);
    const next = vi.fn().mockResolvedValue(undefined);
    queue.enqueue('a', slow);
    queue.enqueue('b', replaced);
    queue.enqueue('b', fast);
    queue.enqueue('c', next);
    expect(slow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(replaced).not.toHaveBeenCalled();
    expect(fast).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(next).toHaveBeenCalledTimes(1);
    finish();
    await vi.runAllTimersAsync();
  });

  it('releases slots on rejection and synchronous errors', async () => {
    const next = vi.fn().mockResolvedValue(undefined);
    queue.enqueue('a', () => Promise.reject(new Error('offline')));
    queue.enqueue('b', () => {
      throw new Error('invalid');
    });
    queue.enqueue('c', next);
    await vi.runAllTimersAsync();
    expect(next).toHaveBeenCalledOnce();
  });

  it('cancels queued keys and never starts work after destruction', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    queue.enqueue('', run);
    queue.clear('');
    queue.enqueue('a', run);
    queue.clear();
    queue.enqueue('b', run);
    queue.destroy();
    queue.enqueue('c', run);
    await vi.runAllTimersAsync();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN])('rejects invalid concurrency %s', concurrency => {
    expect(() => new DeferredTaskQueue(concurrency)).toThrow();
  });
  it.each(['clear', 'destroy'] as const)(
    'cancels dispatched work before its microtask starts: %s',
    mode => {
      const run = vi.fn().mockResolvedValue(undefined);
      queue.enqueue('a', run);
      vi.advanceTimersByTime(0);
      if (mode === 'clear') queue.clear('a');
      else queue.destroy();
      return vi.runAllTimersAsync().then(() => expect(run).not.toHaveBeenCalled());
    }
  );
});

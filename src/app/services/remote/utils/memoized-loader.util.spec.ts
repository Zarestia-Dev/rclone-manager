import { describe, expect, it, vi } from 'vitest';
import { memoizedLoader } from './memoized-loader.util';

describe('memoizedLoader', () => {
  it('shares pending loads, caches success and supports explicit refresh', async () => {
    const load = vi.fn().mockResolvedValue(42);
    const loader = memoizedLoader(load);
    const first = loader.load();
    expect(loader.load()).toBe(first);
    await first;
    expect(await loader.load()).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
    await loader.refresh();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidates immediately and never publishes a late result or clears a newer request', async () => {
    let finish!: (value: string) => void;
    const load = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<string>(resolve => {
          finish = resolve;
        })
      )
      .mockResolvedValueOnce('fresh');
    const loader = memoizedLoader(load);
    const old = loader.load();
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    loader.invalidate();
    expect(loader.status()).toBe('idle');
    expect(loader.signal()).toBeNull();
    await rejected;
    await loader.load();
    finish('stale');
    await Promise.resolve();
    expect(loader.signal()).toBe('fresh');
    expect(loader.status()).toBe('resolved');
  });

  it('reports errors and allows retry', async () => {
    const error = new Error('offline');
    const loader = memoizedLoader(vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(0));
    await expect(loader.load()).rejects.toBe(error);
    expect(loader.error()).toBe(error);
    expect(loader.status()).toBe('error');
    expect(await loader.load()).toBe(0);
    expect(loader.error()).toBeNull();
  });
});

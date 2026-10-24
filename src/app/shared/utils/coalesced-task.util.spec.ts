import { describe, expect, it, vi } from 'vitest';
import { CoalescedTask } from './coalesced-task.util';

describe('CoalescedTask', () => {
  it('starts immediately and merges concurrent requests into one trailing run', async () => {
    let finish!: () => void;
    const refresh = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<void>(resolve => {
          finish = resolve;
        })
      )
      .mockResolvedValue(undefined);
    const task = new CoalescedTask(refresh);
    const first = task.run();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(task.run()).toBe(first);
    expect(task.run()).toBe(first);
    finish();
    await first;
    expect(refresh).toHaveBeenCalledTimes(2);
    await task.run();
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('recovers after synchronous and asynchronous failures', async () => {
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('sync');
      })
      .mockRejectedValueOnce(new Error('async'))
      .mockResolvedValue(undefined);
    const task = new CoalescedTask(refresh);
    await expect(task.run()).rejects.toThrow('sync');
    await expect(task.run()).rejects.toThrow('async');
    await expect(task.run()).resolves.toBeUndefined();
  });
});

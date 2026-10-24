import { DestroyRef } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ConfigResourceState } from './config-resource-state';

const alive = { destroyed: false } as DestroyRef;

describe('configuration metadata resources', () => {
  it('retains independent failures and retries all failed resources', async () => {
    const report = vi.fn();
    const resources = new ConfigResourceState(alive, report);
    const provider = vi.fn().mockRejectedValueOnce(new Error('provider')).mockResolvedValue([]);
    const flags = vi.fn().mockRejectedValueOnce(new Error('flags')).mockResolvedValue([]);
    await resources.load('provider', provider, vi.fn());
    await resources.load('flags', flags, vi.fn());
    expect(resources.failed()).toBe(true);
    await resources.load('unrelated', async () => [], vi.fn());
    expect(resources.failed()).toBe(true);
    await resources.retryFailed();
    expect(resources.failed()).toBe(false);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(flags).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('discards superseded results and keeps concurrent loading state accurate', async () => {
    const resources = new ConfigResourceState(alive, vi.fn());
    let resolveOld!: (value: string) => void;
    let resolveOther!: (value: string) => void;
    const apply = vi.fn();
    const old = resources.load(
      'provider',
      () =>
        new Promise<string>(resolve => {
          resolveOld = resolve;
        }),
      apply
    );
    const other = resources.load(
      'flags',
      () =>
        new Promise<string>(resolve => {
          resolveOther = resolve;
        }),
      apply
    );
    await resources.load('provider', async () => 'new', apply);
    expect(resources.loading()).toBe(true);
    resolveOld('old');
    expect(await old).toBe(false);
    expect(apply).not.toHaveBeenCalledWith('old');
    resolveOther('flags');
    await other;
    expect(resources.loading()).toBe(false);
  });

  it('does not publish a removed resource or a destroyed editor result', async () => {
    const lifetime = { destroyed: false } as { destroyed: boolean };
    const resources = new ConfigResourceState(lifetime as DestroyRef, vi.fn());
    const apply = vi.fn();
    let finish!: (value: string) => void;
    const pending = resources.load(
      'provider',
      () =>
        new Promise<string>(resolve => {
          finish = resolve;
        }),
      apply
    );
    resources.clear('provider');
    finish('removed');
    expect(await pending).toBe(false);
    lifetime.destroyed = true;
    expect(await resources.load('provider', async () => 'destroyed', apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('reports apply failures instead of marking a partially populated resource ready', async () => {
    const error = new Error('invalid metadata');
    const report = vi.fn();
    const resources = new ConfigResourceState(alive, report);
    expect(
      await resources.load(
        'provider',
        async () => [],
        () => {
          throw error;
        }
      )
    ).toBe(false);
    expect(resources.hasFailed('provider')).toBe(true);
    expect(report).toHaveBeenCalledWith(error);
  });
  it('retains available metadata while a refresh is pending or fails', async () => {
    const resources = new ConfigResourceState(alive, vi.fn());
    await resources.load('flags', async () => [], vi.fn());
    let reject!: (error: Error) => void;
    const refresh = resources.load(
      'flags',
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
      vi.fn()
    );
    expect(resources.hasValue('flags')).toBe(true);
    expect(resources.isLoading('flags')).toBe(true);
    reject(new Error('offline'));
    await refresh;
    expect(resources.hasValue('flags')).toBe(true);
    expect(resources.hasFailed('flags')).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { abortableRequest, isAbortError } from './abortable-request.util';

describe('abortableRequest', () => {
  it('returns a result and propagates ordinary failures', async () => {
    const controller = new AbortController();
    expect(await abortableRequest(controller.signal, () => Promise.resolve(42))).toBe(42);
    const error = new Error('offline');
    await expect(abortableRequest(controller.signal, () => Promise.reject(error))).rejects.toBe(
      error
    );
    await expect(
      abortableRequest(controller.signal, () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(isAbortError(error)).toBe(false);
  });

  it('rejects pending work immediately and consumes a later transport rejection', async () => {
    const controller = new AbortController();
    let fail!: (error: unknown) => void;
    const pending = abortableRequest(
      controller.signal,
      () =>
        new Promise((_, reject) => {
          fail = reject;
        })
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    fail(new Error('late transport failure'));
    await Promise.resolve();
  });

  it('does not start an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn();
    await expect(abortableRequest(controller.signal, operation)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(operation).not.toHaveBeenCalled();
    expect(isAbortError(new DOMException('cancelled', 'AbortError'))).toBe(true);
  });
});

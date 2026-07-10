import { signal, Signal } from '@angular/core';

export interface MemoizedLoader<T> {
  readonly signal: Signal<T | null>;
  load: () => Promise<T>;
}

export function memoizedLoader<T>(loader: () => Promise<T>): MemoizedLoader<T> {
  const _signal = signal<T | null>(null);
  let _promise: Promise<T> | null = null;

  const load = (): Promise<T> => {
    const current = _signal();
    if (current !== null) return Promise.resolve(current);
    if (_promise) return _promise;

    _promise = (async (): Promise<T> => {
      try {
        const result = await loader();
        _signal.set(result);
        return result;
      } finally {
        _promise = null;
      }
    })();

    return _promise;
  };

  return { signal: _signal.asReadonly(), load };
}

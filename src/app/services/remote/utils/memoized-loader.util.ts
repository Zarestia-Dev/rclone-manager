import { computed, signal, Signal } from '@angular/core';
import { abortableRequest } from 'src/app/shared/utils/abortable-request.util';

export type LoaderStatus = 'idle' | 'loading' | 'resolved' | 'error';

export interface MemoizedLoader<T> {
  /** Current value, or `null` if not yet loaded. */
  readonly signal: Signal<T | null>;
  /** Current status. */
  readonly status: Signal<LoaderStatus>;
  /** True when an initial load or refresh is in progress. */
  readonly isLoading: Signal<boolean>;
  /** Last error encountered, or `null` if none. */
  readonly error: Signal<unknown>;
  /** Loads the value (returns cached if already loaded; dedupes concurrent calls). */
  load: () => Promise<T>;
  /** Forces a fresh load, ignoring any cached value. */
  refresh: () => Promise<T>;
  /** Clears the value and rejects pending readers without waiting for the old transport. */
  invalidate: () => void;
}

/**
 * Imperative memoized loader with signal-based state.
 *
 * Deduplicates reads until invalidated; stale requests never publish into a new scope.
 */
export function memoizedLoader<T>(loader: () => Promise<T>): MemoizedLoader<T> {
  const valueSignal = signal<T | null>(null);
  const statusSignal = signal<LoaderStatus>('idle');
  const errorSignal = signal<unknown>(null);
  const isLoading = computed(() => statusSignal() === 'loading');
  let pending: Promise<T> | null = null;
  let controller: AbortController | null = null;

  const run = async (): Promise<T> => {
    const current = new AbortController();
    controller = current;
    statusSignal.set('loading');
    try {
      const result = await abortableRequest(current.signal, loader);
      if (controller !== current) throw new DOMException('Request superseded', 'AbortError');
      valueSignal.set(result);
      errorSignal.set(null);
      statusSignal.set('resolved');
      return result;
    } catch (err) {
      if (controller === current) {
        errorSignal.set(err);
        statusSignal.set('error');
      }
      throw err;
    } finally {
      if (controller === current) {
        pending = null;
        controller = null;
      }
    }
  };

  const load = (): Promise<T> => {
    if (statusSignal() === 'resolved') return Promise.resolve(valueSignal() as T);
    if (pending) return pending;
    pending = run();
    return pending;
  };

  const refresh = (): Promise<T> => {
    if (pending) return pending;
    pending = run();
    return pending;
  };

  const invalidate = (): void => {
    controller?.abort();
    controller = null;
    pending = null;
    valueSignal.set(null);
    statusSignal.set('idle');
    errorSignal.set(null);
  };

  return {
    signal: valueSignal.asReadonly(),
    status: statusSignal.asReadonly(),
    isLoading,
    error: errorSignal.asReadonly(),
    load,
    refresh,
    invalidate,
  };
}

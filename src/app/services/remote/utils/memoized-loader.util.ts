import { computed, signal, Signal } from '@angular/core';

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
}

/**
 * Imperative memoized loader with signal-based state.
 *
 * Designed as a lightweight, Promise-friendly alternative to Angular's
 * `resource()` for cases where the loader is parameterless and called
 * imperatively rather than reactively. Exposes a `resource()`-compatible
 * API surface (`status`, `isLoading`, `error`, `value`-as-`signal`) so
 * consumers can be migrated to `resource()` later if reactive params
 * become necessary.
 */
export function memoizedLoader<T>(loader: () => Promise<T>): MemoizedLoader<T> {
  const valueSignal = signal<T | null>(null);
  const statusSignal = signal<LoaderStatus>('idle');
  const errorSignal = signal<unknown>(null);
  const isLoading = computed(() => statusSignal() === 'loading');
  let pending: Promise<T> | null = null;

  const run = async (): Promise<T> => {
    statusSignal.set('loading');
    try {
      const result = await loader();
      valueSignal.set(result);
      errorSignal.set(null);
      statusSignal.set('resolved');
      return result;
    } catch (err) {
      errorSignal.set(err);
      statusSignal.set('error');
      throw err;
    } finally {
      pending = null;
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

  return {
    signal: valueSignal.asReadonly(),
    status: statusSignal.asReadonly(),
    isLoading,
    error: errorSignal.asReadonly(),
    load,
    refresh,
  };
}

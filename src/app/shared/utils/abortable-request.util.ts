/** Stops awaiting superseded work, even when the underlying transport cannot cancel it. */
export function abortableRequest<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  const aborted = (): DOMException => new DOMException('Request superseded', 'AbortError');
  let onAbort: () => void;
  const result = new Promise<T>((resolve, reject) => {
    onAbort = (): void => reject(aborted());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      void operation().then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
  return result
    .finally(() => signal.removeEventListener('abort', onAbort))
    .then(value => {
      if (signal.aborted) throw aborted();
      return value;
    });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

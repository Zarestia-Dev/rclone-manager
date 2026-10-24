import { computed, DestroyRef, signal } from '@angular/core';

interface ResourceState {
  status: 'loading' | 'ready' | 'error';
  available: boolean;
  retry: () => Promise<boolean>;
}

/** Tracks editor metadata independently; the data services own caching. */
export class ConfigResourceState {
  private readonly resources = signal<ReadonlyMap<string, ResourceState>>(new Map());
  readonly failed = computed(() =>
    [...this.resources().values()].some(resource => resource.status === 'error')
  );
  readonly loading = computed(() =>
    [...this.resources().values()].some(resource => resource.status === 'loading')
  );

  constructor(
    private readonly destroyRef: DestroyRef,
    private readonly onError: (error: unknown) => void
  ) {}

  isLoading(key: string): boolean {
    return this.resources().get(key)?.status === 'loading';
  }

  isReady(key: string): boolean {
    return this.resources().get(key)?.status === 'ready';
  }

  hasValue(key: string): boolean {
    return this.resources().get(key)?.available ?? false;
  }

  hasFailed(key: string): boolean {
    return this.resources().get(key)?.status === 'error';
  }

  clear(key: string): void {
    this.resources.update(current => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }

  async load<T>(
    key: string,
    loader: () => Promise<T>,
    apply: (value: T) => void
  ): Promise<boolean> {
    if (this.destroyRef.destroyed) return false;
    const resource: ResourceState = {
      status: 'loading',
      available: this.hasValue(key),
      retry: () => this.load(key, loader, apply),
    };
    this.resources.update(current => new Map(current).set(key, resource));
    const isCurrent = (): boolean =>
      !this.destroyRef.destroyed && this.resources().get(key) === resource;
    try {
      const value = await loader();
      if (!isCurrent()) return false;
      apply(value);
      if (!isCurrent()) return false;
      this.resources.update(current =>
        new Map(current).set(key, { ...resource, status: 'ready', available: true })
      );
      return true;
    } catch (error) {
      if (isCurrent()) {
        this.resources.update(current =>
          new Map(current).set(key, { ...resource, status: 'error' })
        );
        this.onError(error);
      }
      return false;
    }
  }

  async retryFailed(): Promise<void> {
    await Promise.all(
      [...this.resources().values()]
        .filter(resource => resource.status === 'error')
        .map(resource => resource.retry())
    );
  }
}

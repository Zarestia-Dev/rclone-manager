import { DestroyRef, Injectable, Signal, WritableSignal, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DiskUsage, Origin } from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { PathService } from '../infrastructure/platform/path.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { VaultService } from '../security/vault.service';
import { RemoteFileOperationsService } from './remote-file-operations.service';
import { DeferredTaskQueue } from 'src/app/shared/utils/deferred-task-queue.util';
import { abortableRequest, isAbortError } from 'src/app/shared/utils/abortable-request.util';

interface DiskState {
  value: WritableSignal<DiskUsage>;
  request?: { controller: AbortController; promise: Promise<DiskUsage | null> };
}

interface DiskLoadOptions {
  source?: Origin;
  group?: string;
  force?: boolean;
}

/** Owns capacity caching, request deduplication and background loading independently of the UI. */
@Injectable({ providedIn: 'root' })
export class RemoteDiskUsageService extends TauriBaseService {
  private readonly ops = inject(RemoteFileOperationsService);
  private readonly paths = inject(PathService);
  private readonly vault = inject(VaultService);
  private readonly events = inject(EventListenersService);
  private readonly states = new Map<string, DiskState>();
  private readonly queue = new DeferredTaskQueue();

  constructor() {
    super();
    this.events
      .listenToBackendSwitched()
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.clear());
    this.events
      .listenToVaultState()
      .pipe(takeUntilDestroyed())
      .subscribe(state => {
        if (state.isLocked) this.clear();
      });
    inject(DestroyRef).onDestroy(() => {
      this.queue.destroy();
      this.clear();
    });
  }

  private state(fs: string): DiskState {
    let state = this.states.get(fs);
    if (!state) {
      state = { value: signal<DiskUsage>({ loading: true, error: false }) };
      this.states.set(fs, state);
    }
    return state;
  }

  usage(remote: string): Signal<DiskUsage> {
    return this.state(this.paths.normalizeRemoteForRclone(remote)).value.asReadonly();
  }

  prefetch(remotes: readonly string[]): void {
    this.queue.clear();
    if (!this.vault.isAccessible()) return;
    for (const remote of remotes) {
      const fs = this.paths.normalizeRemoteForRclone(remote);
      const state = this.state(fs);
      if (!state.request && !this.isCached(state.value())) {
        this.queue.enqueue(fs, () => this.load(remote));
      }
    }
  }

  private isCached(value: DiskUsage): boolean {
    return !!value.notSupported || (value.total !== undefined && !value.loading && !value.error);
  }

  async load(remote: string, options: DiskLoadOptions = {}): Promise<DiskUsage | null> {
    if (!remote.trim() || !this.vault.isAccessible()) return null;
    const fs = this.paths.normalizeRemoteForRclone(remote);
    const state = this.state(fs);
    if (!options.force) {
      if (state.request) return state.request.promise;
      if (this.isCached(state.value())) return state.value();
    }
    this.queue.clear(fs);
    state.request?.controller.abort();
    const controller = new AbortController();
    state.value.set({ loading: true, error: false });
    const promise = this.fetch(fs, options, controller.signal)
      .then(value => {
        if (controller.signal.aborted) return null;
        state.value.set(value);
        return value.error ? null : value;
      })
      .catch(error => {
        if (isAbortError(error)) return null;
        throw error;
      });
    state.request = { controller, promise };
    try {
      return await promise;
    } finally {
      if (state.request?.controller === controller) state.request = undefined;
    }
  }

  private async fetch(
    fs: string,
    options: DiskLoadOptions,
    signal: AbortSignal
  ): Promise<DiskUsage> {
    try {
      const usage = await abortableRequest(signal, () =>
        this.ops.getDiskUsage(fs, undefined, options.source ?? 'dashboard', options.group)
      );
      return { ...usage, loading: false, error: false, notSupported: false };
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (String(error).toLowerCase().includes("doesn't support")) {
        return { loading: false, error: false, notSupported: true };
      }
      return {
        loading: false,
        error: true,
        errorMessage: this.backendTranslation.translateBackendMessage(error),
      };
    }
  }

  clear(remote?: string): void {
    const fs = remote === undefined ? undefined : this.paths.normalizeRemoteForRclone(remote);
    this.queue.clear(fs);
    const entries = fs === undefined ? this.states.values() : [this.states.get(fs)];
    for (const state of entries) {
      if (!state) continue;
      state.request?.controller.abort();
      state.request = undefined;
      state.value.set({ loading: true, error: false });
    }
  }
}

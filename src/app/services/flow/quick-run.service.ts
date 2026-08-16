import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { combineLatest } from 'rxjs';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import {
  QuickRun,
  QuickRunInput,
  QuickRunStatus,
  PrimaryActionType,
  MountedRemote,
  ServeListItem,
  JobInfo,
  OperationExecutionResult,
} from '@app/types';
import { JobManagementService } from '../operations/job-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { AutomationService } from '../operations/automation.service';
import { ModalService } from '../ui/modal.service';
import { findUniqueName } from '../remote/utils/unique-name.util';

/**
 * Front-end store for the Flow workspace's "Quick Run" feature.
 */
@Injectable({ providedIn: 'root' })
export class QuickRunService extends TauriBaseService {
  private readonly jobService = inject(JobManagementService);
  private readonly mountService = inject(MountManagementService);
  private readonly serveService = inject(ServeManagementService);
  private readonly automationService = inject(AutomationService);
  private readonly modalService = inject(ModalService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _quickRuns = signal<QuickRun[]>([]);
  private readonly _selectedId = signal<string | null>(null);
  private readonly _isCreating = signal(false);
  private readonly _isLoading = signal(false);
  private readonly _isSaving = signal(false);
  private readonly _runningIds = signal<Set<string>>(new Set());

  readonly quickRuns = this._quickRuns.asReadonly();

  /** Sorted view of quick runs — only use when you actually need alphabetical order. */
  readonly sortedQuickRuns = computed(() =>
    this._quickRuns()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  );
  /** Id of the quick run currently shown in the inspect view, if any. */
  readonly selectedId = this._selectedId.asReadonly();
  /** True while the editor panel is open in "create" mode. */
  readonly isCreating = this._isCreating.asReadonly();
  /** True while the initial list is being fetched from the backend. */
  readonly isLoading = this._isLoading.asReadonly();
  /** True while a create/update is in flight. */
  readonly isSaving = this._isSaving.asReadonly();
  /** Set of quick-run ids currently executing (drives card badges + buttons). */
  readonly runningIds = this._runningIds.asReadonly();

  /** The currently-selected quick run, or `null`. */
  readonly selected = computed<QuickRun | null>(
    () => this._quickRuns().find(qr => qr.id === this._selectedId()) ?? null
  );

  /** Quick runs that are currently running — shown first in the card grid. */
  readonly runningQuickRuns = computed(() =>
    this.quickRuns().filter(qr => this._runningIds().has(qr.id) || qr.status === 'running')
  );

  /** Quick runs that are not currently running — shown after the running ones. */
  readonly idleQuickRuns = computed(() =>
    this.quickRuns().filter(qr => !this._runningIds().has(qr.id) && qr.status !== 'running')
  );

  constructor() {
    super();
    void this.refresh();
    this.listenToStatusUpdates();
  }

  private isUpdatingStatus = false;

  private listenToStatusUpdates(): void {
    combineLatest([
      toObservable(this.jobService.jobs),
      toObservable(this.mountService.mountedRemotes),
      toObservable(this.serveService.runningServes),
      toObservable(this._quickRuns),
    ])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([jobs, mounts, serves, quickRuns]) => {
        if (this.isUpdatingStatus) return;
        if (!quickRuns || quickRuns.length === 0) return;

        this.isUpdatingStatus = true;
        try {
          const nextRunningIds = new Set<string>();
          const patches: { id: string; patch: Partial<QuickRun> }[] = [];

          for (const qr of quickRuns) {
            if (qr.operationType === 'mount') {
              const isMounted = this.isMountActive(qr, mounts ?? []);
              if (isMounted) {
                nextRunningIds.add(qr.id);
                if (qr.status !== 'running') {
                  patches.push({ id: qr.id, patch: { status: 'running' } });
                }
              } else if (qr.status === 'running') {
                patches.push({ id: qr.id, patch: { status: 'stopped' } });
              }
            } else if (qr.operationType === 'serve') {
              const isServing = this.isServeActive(qr, serves ?? []);
              if (isServing) {
                nextRunningIds.add(qr.id);
                if (qr.status !== 'running') {
                  patches.push({ id: qr.id, patch: { status: 'running' } });
                }
              } else if (qr.status === 'running') {
                patches.push({ id: qr.id, patch: { status: 'stopped' } });
              }
            } else {
              const job = this.getMatchingJob(qr, jobs ?? []);
              if (job) {
                const statusLower = job.status.toLowerCase();
                if (statusLower === 'running') {
                  nextRunningIds.add(qr.id);
                  if (qr.status !== 'running') {
                    patches.push({ id: qr.id, patch: { status: 'running' } });
                  }
                } else {
                  const finalStatus: QuickRunStatus =
                    statusLower === 'completed' || statusLower === 'finished'
                      ? 'completed'
                      : statusLower === 'failed'
                        ? 'failed'
                        : 'stopped';
                  if (qr.status !== finalStatus) {
                    patches.push({ id: qr.id, patch: { status: finalStatus } });
                  }
                }
              }
            }
          }

          // Apply all patches in a single batch update to minimize signal emissions.
          if (patches.length > 0) {
            this._quickRuns.update(list => {
              const patchMap = new Map(patches.map(p => [p.id, p.patch]));
              return list.map(qr => {
                const patch = patchMap.get(qr.id);
                return patch ? { ...qr, ...patch } : qr;
              });
            });
          }

          // Only update runningIds if the set actually changed.
          const currentSet = this._runningIds();
          let changed = currentSet.size !== nextRunningIds.size;
          if (!changed) {
            for (const id of nextRunningIds) {
              if (!currentSet.has(id)) {
                changed = true;
                break;
              }
            }
          }
          if (changed) {
            this._runningIds.set(nextRunningIds);
          }
        } finally {
          this.isUpdatingStatus = false;
        }
      });
  }

  private isMountActive(qr: QuickRun, mounts: MountedRemote[]): boolean {
    return mounts.some(m => m.quick_run_id === qr.id);
  }

  private isServeActive(qr: QuickRun, serves: ServeListItem[]): boolean {
    return serves.some(s => s.quick_run_id === qr.id);
  }

  private getMatchingJob(qr: QuickRun, jobs: JobInfo[]): JobInfo | undefined {
    return jobs
      .filter(j => j.quick_run_id === qr.id)
      .sort((a, b) => {
        const ta = a.start_time ? new Date(a.start_time).getTime() : 0;
        const tb = b.start_time ? new Date(b.start_time).getTime() : 0;
        return tb !== ta ? tb - ta : b.jobid - a.jobid;
      })[0];
  }

  // ── Selection ────────────────────────────────────────────────────────────

  select(id: string | null): void {
    this._selectedId.set(id);
  }

  deselect(): void {
    this._selectedId.set(null);
  }

  isSelected(id: string): boolean {
    return this._selectedId() === id;
  }

  // ── Editor lifecycle ─────────────────────────────────────────────────────

  generateUniqueQuickRunName(baseName: string): string {
    const base = baseName
      .replace(/-\d+$/, '')
      .replace(/\s*\(copy\)$/i, '')
      .trim();
    const existing = this._quickRuns().map(qr => qr.name);
    return findUniqueName(base || 'quickrun', existing);
  }

  openEditor(
    input?: QuickRunInput | QuickRun,
    initialOpType?: PrimaryActionType,
    initialRemoteName?: string
  ): void {
    if (input && 'id' in input && input.id) {
      this.modalService.openQuickRunEditor({
        quickRun: input as QuickRun,
        initialOpType,
        initialRemoteName,
      });
    } else if (input) {
      this.modalService.openQuickRunEditor({
        cloneData: input,
        initialOpType: initialOpType ?? input.operationType,
        initialRemoteName: initialRemoteName ?? input.remoteName,
      });
    } else {
      this.modalService.openQuickRunEditor({
        initialOpType,
        initialRemoteName,
      });
    }
  }

  // ── Backend commands ─────────────────────────────────────────────────────

  /**
   * Refresh the in-memory store from the backend. If the backend command
   * isn't registered yet (pre-Rust), we silently keep an empty list so the
   * UI can still be exercised.
   */
  async refresh(): Promise<void> {
    this._isLoading.set(true);
    try {
      const list = await this.invokeCommand<QuickRun[]>('list_quick_runs');
      const mappedList = (list ?? []).map(qr => ({ ...qr, status: qr.status ?? 'idle' }));
      this._quickRuns.set(mappedList);
      void this.mountService.getMountedRemotes();
      void this.serveService.refreshServes();
      void this.jobService.refreshJobs();
      void this.automationService.refreshAutomations();
    } catch (err) {
      console.warn('[QuickRunService] list_quick_runs not available, running in-memory only:', err);
      // In-memory fallback — keep whatever we already have.
    } finally {
      this._isLoading.set(false);
    }
  }

  /**
   * Persist a new quick run (or update an existing one if `id` is set).
   * On success the in-memory store is updated and the editor closes.
   */
  async save(input: QuickRunInput): Promise<QuickRun | null> {
    this._isSaving.set(true);
    try {
      const saved = input.id
        ? await this.invokeCommand<QuickRun>('update_quick_run', {
            quickRun: { ...input, id: input.id },
          })
        : await this.invokeCommand<QuickRun>('create_quick_run', { quickRun: input });

      const itemToStore = saved
        ? { ...saved, status: saved.status ?? 'idle' }
        : this.synthesizeLocal(input);

      this.mergeIntoStore(itemToStore);
      void this.automationService.refreshAutomations();
      return itemToStore;
    } catch (err) {
      console.error('[QuickRunService] save failed, falling back to in-memory:', err);
      const local = this.synthesizeLocal(input);
      this.mergeIntoStore(local);
      return local;
    } finally {
      this._isSaving.set(false);
    }
  }

  /** Delete a quick run by id. */
  async remove(id: string): Promise<void> {
    try {
      await this.invokeCommand('delete_quick_run', { quickRunId: id });
    } catch (err) {
      console.warn('[QuickRunService] delete_quick_run not available, removing locally:', err);
    }
    this._quickRuns.update(list => list.filter(qr => qr.id !== id));
    if (this._selectedId() === id) this._selectedId.set(null);
    void this.automationService.refreshAutomations();
  }

  /**
   * Duplicate an existing quick run by opening the editor modal prefilled
   * with the source configuration and an auto-generated unique name (e.g. `Name-1`).
   */
  duplicate(id: string): void {
    const source = this._quickRuns().find(qr => qr.id === id);
    if (!source) return;
    const newName = this.generateUniqueQuickRunName(source.name);
    const cloneData: QuickRunInput = {
      name: newName,
      description: source.description,
      operationType: source.operationType,
      remoteName: source.remoteName,
      config: structuredClone(source.config),
    };
    this.openEditor(cloneData);
  }

  // ── Execution ────────────────────────────────────────────────────────────

  /**
   * Start a quick run. Returns the execution result descriptor on success.
   */
  async start(id: string): Promise<OperationExecutionResult | null> {
    const qr = this._quickRuns().find(q => q.id === id);
    if (!qr) return null;

    this.markRunning(id);
    try {
      const result = await this.invokeCommand<OperationExecutionResult>('start_quick_run', {
        quickRunId: id,
      });
      this.patchInStore(id, { status: result?.status ?? 'running' });
      void this.jobService.refreshJobs();
      void this.mountService.getMountedRemotes();
      void this.serveService.refreshServes();
      return result;
    } catch (err) {
      console.error('[QuickRunService] start_quick_run failed:', err);
      this.notificationService.showError(`Failed to start "${qr.name}".`);
      this.markStopped(id, { status: 'failed' });
      return null;
    }
  }

  /** Stop a running quick run. */
  async stop(id: string): Promise<void> {
    try {
      await this.invokeCommand('stop_quick_run', { quickRunId: id });
    } catch (err) {
      console.warn('[QuickRunService] stop_quick_run not available:', err);
    }
    this.markStopped(id, { status: 'stopped' });
    void this.jobService.refreshJobs();
    void this.mountService.getMountedRemotes();
    void this.serveService.refreshServes();
  }

  // ── Runtime state helpers ────────────────────────────────────────────────

  markRunning(id: string): void {
    this._runningIds.update(set => new Set(set).add(id));
    this.patchInStore(id, { status: 'running' });
  }

  markStopped(id: string, patch: Partial<Pick<QuickRun, 'status'>>): void {
    this._runningIds.update(set => {
      const next = new Set(set);
      next.delete(id);
      return next;
    });
    this.patchInStore(id, {
      status: patch.status ?? 'idle',
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private mergeIntoStore(qr: QuickRun): void {
    this._quickRuns.update(list => {
      const idx = list.findIndex(item => item.id === qr.id);
      if (idx === -1) return [...list, qr];
      const next = list.slice();
      next[idx] = qr;
      return next;
    });
  }

  private patchInStore(id: string, patch: Partial<QuickRun>): void {
    this._quickRuns.update(list => list.map(qr => (qr.id === id ? { ...qr, ...patch } : qr)));
  }

  /**
   * Build a fully-formed {@link QuickRun} from a {@link QuickRunInput} when
   * the backend isn't available. The synthesised record uses a random id and `status: 'idle'`.
   */
  private synthesizeLocal(input: QuickRunInput): QuickRun {
    return {
      id: input.id ?? this.generateId(),
      name: input.name,
      description: input.description,
      operationType: input.operationType,
      remoteName: input.remoteName,
      config: input.config,
      status: 'idle' satisfies QuickRunStatus,
    };
  }

  private generateId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `qr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { merge } from 'rxjs';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import {
  QuickRun,
  QuickRunInput,
  PrimaryActionType,
  OperationExecutionResult,
  JOB_STATUS,
  quickRunIdOf,
} from '@app/types';
import { JobManagementService } from '../operations/job-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { ModalService } from '../ui/modal.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { CoalescedTask } from 'src/app/shared/utils/coalesced-task.util';
import { findUniqueName } from '../remote/utils/unique-name.util';

/**
 * Front-end store for the Flow workspace's "Quick Run" feature.
 */
@Injectable({ providedIn: 'root' })
export class QuickRunService extends TauriBaseService {
  private readonly jobService = inject(JobManagementService);
  private readonly mountService = inject(MountManagementService);
  private readonly serveService = inject(ServeManagementService);
  private readonly modalService = inject(ModalService);
  private readonly eventListeners = inject(EventListenersService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _quickRuns = signal<QuickRun[]>([]);
  private readonly _selectedId = signal<string | null>(null);
  private readonly _isLoading = signal(false);
  private readonly _isSaving = signal(false);
  private readonly _actionInProgress = signal<Record<string, 'start' | 'stop'>>({});

  private readonly refreshTask = new CoalescedTask(() => this.load());

  readonly quickRuns = this._quickRuns.asReadonly();

  /** Id of the quick run currently shown in the inspect view, if any. */
  readonly selectedId = this._selectedId.asReadonly();
  /** True while the initial list is being fetched from the backend. */
  readonly isLoading = this._isLoading.asReadonly();
  /** True while a create/update is in flight. */
  readonly isSaving = this._isSaving.asReadonly();
  /**
   * Quick-run ids currently executing (drives card badges + buttons). Derived from the live
   * job, mount and serve stores, so there is no second copy of the state to keep in sync.
   */
  readonly runningIds = computed<ReadonlySet<string>>(
    () => {
      const idsOf = (items: Parameters<typeof quickRunIdOf>[0][]): Set<string> =>
        new Set(items.map(quickRunIdOf).filter((id): id is string => Boolean(id)));
      const jobs = idsOf(
        this.jobService
          .jobs()
          .filter(job => job.status === JOB_STATUS.Running && job.parent_job_id == null)
      );
      const mounts = idsOf(this.mountService.mountedRemotes());
      const serves = idsOf(this.serveService.runningServes());

      const running = new Set<string>();
      for (const { id, operationType } of this._quickRuns()) {
        const source =
          operationType === 'mount' ? mounts : operationType === 'serve' ? serves : jobs;
        if (source.has(id)) running.add(id);
      }
      return running;
    },
    { equal: (a, b) => a.size === b.size && [...a].every(id => b.has(id)) }
  );
  /** In-flight action states per quick-run ID (e.g. 'start' or 'stop'). */
  readonly actionInProgress = this._actionInProgress.asReadonly();

  /** The currently-selected quick run, or `null`. */
  readonly selected = computed<QuickRun | null>(
    () => this._quickRuns().find(qr => qr.id === this._selectedId()) ?? null
  );

  constructor() {
    super();
    void this.refresh();

    // Quick Runs belong to the selected backend.
    merge(
      this.eventListeners.listenToSettingsCategory('quick_runs'),
      this.eventListeners.listenToBackendSwitched()
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        void this.refresh();
      });
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

  /** Reload the list from the backend; concurrent calls share one request plus a trailing run. */
  refresh(): Promise<void> {
    return this.refreshTask.run();
  }

  private async load(): Promise<void> {
    this._isLoading.set(true);
    try {
      this._quickRuns.set((await this.invokeCommand<QuickRun[]>('list_quick_runs')) ?? []);
    } catch (err) {
      console.error('[QuickRunService] list_quick_runs failed:', err);
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
        ? await this.invokeWithNotification<QuickRun>('update_quick_run', {
            quickRun: { ...input, id: input.id },
          })
        : await this.invokeWithNotification<QuickRun>('create_quick_run', { quickRun: input });

      if (!saved) return null;

      this.mergeIntoStore(saved);
      return saved;
    } catch (err) {
      console.error('[QuickRunService] save failed:', err);
      return null;
    } finally {
      this._isSaving.set(false);
    }
  }

  /** Delete a quick run by id. */
  async remove(id: string): Promise<void> {
    try {
      await this.invokeWithNotification('delete_quick_run', { quickRunId: id });
      this._quickRuns.update(list => list.filter(qr => qr.id !== id));
      if (this._selectedId() === id) this._selectedId.set(null);
    } catch (err) {
      console.error('[QuickRunService] delete_quick_run failed:', err);
    }
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

  /** Run an action while exposing its in-flight state to the card buttons. */
  private async executeAction<T>(
    id: string,
    action: 'start' | 'stop',
    operation: () => Promise<T>
  ): Promise<T> {
    this._actionInProgress.update(state => ({ ...state, [id]: action }));
    try {
      return await operation();
    } finally {
      this._actionInProgress.update(state => {
        const next = { ...state };
        delete next[id];
        return next;
      });
    }
  }

  /**
   * Start a quick run. Returns the execution result descriptor on success. The button stays
   * busy until the job, mount and serve stores have caught up, so it never flashes "idle".
   */
  async start(id: string): Promise<OperationExecutionResult | null> {
    const qr = this._quickRuns().find(q => q.id === id);
    if (!qr) return null;

    return await this.executeAction(id, 'start', async () => {
      try {
        const result = await this.invokeWithNotification<OperationExecutionResult>(
          'start_quick_run',
          { quickRunId: id },
          {
            successKey: 'flow.quickRun.success.started',
            successParams: { name: qr.name },
            errorKey: 'flow.quickRun.errors.failedStart',
            errorParams: { name: qr.name },
          }
        );
        await this.refreshOperationStates();
        return result;
      } catch (err) {
        console.error('[QuickRunService] start_quick_run failed:', err);
        return null;
      }
    });
  }

  /** Stop a running quick run. */
  async stop(id: string): Promise<void> {
    const qr = this._quickRuns().find(q => q.id === id);
    await this.executeAction(id, 'stop', async () => {
      try {
        await this.invokeWithNotification(
          'stop_quick_run',
          { quickRunId: id },
          {
            errorKey: 'flow.quickRun.errors.failedStop',
            errorParams: { name: qr?.name ?? id },
          }
        );
      } catch (err) {
        console.error('[QuickRunService] stop_quick_run failed:', err);
      } finally {
        await this.refreshOperationStates();
      }
    });
  }

  private async refreshOperationStates(): Promise<void> {
    await Promise.allSettled([
      this.jobService.refreshJobs(),
      this.mountService.getMountedRemotes(),
      this.serveService.refreshServes(),
    ]);
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
}

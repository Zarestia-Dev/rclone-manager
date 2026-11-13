import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { BisyncConflict } from '@app/types';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { ModalService } from 'src/app/services/ui/modal.service';
import { splitPath, withMember } from '../transfer-activity-panel/activity.utils';

import { PillDirective } from '../../directives/pill.directive';
/** The files a finished bisync run could not reconcile, with a way to pick the version to keep. */
@Component({
  selector: 'app-bisync-conflicts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatCheckboxModule,
    TranslatePipe,
    CopyToClipboardDirective,
    PillDirective,
  ],
  templateUrl: './bisync-conflicts.component.html',
})
export class BisyncConflictsComponent {
  private readonly jobService = inject(JobManagementService);
  private readonly fileOps = inject(RemoteFileOperationsService);
  private readonly notifications = inject(NotificationService);
  private readonly modals = inject(ModalService);
  private readonly translate = inject(TranslateService);
  private readonly backendTranslation = inject(BackendTranslationService);

  readonly jobId = input.required<number>();
  readonly path1 = input.required<string>();
  readonly path2 = input.required<string>();
  readonly searchTerm = input('');

  protected readonly splitName = splitPath;

  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  private readonly all = signal<BisyncConflict[]>([]);
  /** Settled from here, by the file's name. */
  protected readonly settled = signal<ReadonlyMap<string, 'path1' | 'path2'>>(new Map());
  protected readonly busy = signal(false);
  private readonly resolving = signal<ReadonlySet<string>>(new Set());

  protected readonly rows = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const settled = this.settled();
    const resolving = this.resolving();
    return this.all()
      .filter(conflict => !term || conflict.path.toLowerCase().includes(term))
      .map(conflict => ({
        conflict,
        settledKeep: settled.get(conflict.path) ?? null,
        resolving: resolving.has(conflict.path),
      }));
  });
  protected readonly openRows = computed(() => this.rows().filter(row => !row.settledKeep));
  /** Names the user ticked; only conflicts that are still open count. */
  protected readonly selection = signal<ReadonlySet<string>>(new Set());
  protected readonly selectedRows = computed(() => {
    const selection = this.selection();
    return this.openRows().filter(row => selection.has(row.conflict.path));
  });
  protected readonly allSelected = computed(
    () => this.openRows().length > 0 && this.selectedRows().length === this.openRows().length
  );

  constructor() {
    effect(() => {
      const jobId = this.jobId();
      untracked(() => void this.load(jobId));
    });
  }

  private async load(jobId: number): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    this.settled.set(new Map());
    this.selection.set(new Set());
    try {
      const report = await this.jobService.getJobReport(jobId);
      if (jobId === this.jobId()) this.all.set(report?.conflicts ?? []);
    } catch (error) {
      console.error('Failed to load the bisync conflicts:', error);
      if (jobId === this.jobId()) {
        this.all.set([]);
        this.failed.set(true);
      }
    } finally {
      if (jobId === this.jobId()) this.loading.set(false);
    }
  }

  protected toggle(name: string, checked: boolean): void {
    this.selection.update(selection => withMember(selection, name, checked));
  }

  protected toggleAll(checked: boolean): void {
    this.selection.set(
      checked ? new Set(this.openRows().map(row => row.conflict.path)) : new Set()
    );
  }

  protected clearSelection(): void {
    this.selection.set(new Set());
  }

  protected resolveOne(conflict: BisyncConflict): Promise<void> {
    return this.review([conflict]);
  }

  protected reviewSelected(): Promise<void> {
    return this.review(this.selectedRows().map(row => row.conflict));
  }

  /**
   * Asks about the conflicts in one dialog. Each answer starts its change at once and the dialog
   * goes on to the next conflict, so a slow remote never holds the questions up.
   */
  private async review(conflicts: BisyncConflict[]): Promise<void> {
    if (!conflicts.length || this.busy()) return;
    this.busy.set(true);
    try {
      await firstValueFrom(
        this.modals
          .openCheckCompare({
            bisync: true,
            entries: conflicts.map(conflict => ({
              name: conflict.path,
              src: { fs: this.path1(), path: conflict.path1Now },
              dst: { fs: this.path2(), path: conflict.path2Now },
              target: {
                src: { fs: this.path1(), path: conflict.path },
                dst: { fs: this.path2(), path: conflict.path },
              },
            })),
            apply: (index, direction) =>
              void this.keep(conflicts[index], direction === 'toDestination' ? 'path1' : 'path2'),
          })
          .afterClosed()
      );
    } finally {
      this.busy.set(false);
    }
  }

  private async keep(conflict: BisyncConflict, keep: 'path1' | 'path2'): Promise<void> {
    const key = conflict.path;
    this.resolving.update(set => withMember(set, key, true));
    try {
      await this.fileOps.resolveBisyncConflict(
        this.path1(),
        this.path2(),
        conflict,
        keep,
        'dashboard'
      );
      this.settled.update(map => new Map(map).set(key, keep));
      this.selection.update(selection => withMember(selection, key, false));
      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.conflicts.resolved', { name: key })
      );
    } catch (error) {
      console.error('Failed to resolve the bisync conflict:', error);
      this.notifications.showError(
        this.backendTranslation.translateBackendMessage(
          error instanceof Error ? error.message : String(error)
        )
      );
    } finally {
      this.resolving.update(set => withMember(set, key, false));
    }
  }
}

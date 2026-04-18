import { NgClass, DecimalPipe, TitleCasePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
  computed,
  output,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBarModule, MatSnackBar } from '@angular/material/snack-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';

import {
  JobInfo,
  PrimaryActionType,
  Remote,
  ScheduledTask,
  ServeListItem,
  CardDisplayMode,
} from '@app/types';

import { FormatTimePipe } from '../../../../shared/pipes/format-time.pipe';
import { FormatEtaPipe } from '../../../../shared/pipes/format-eta.pipe';
import { FormatMemoryUsagePipe } from '../../../../shared/pipes/format-memory-usage.pipe';
import { RemotesPanelComponent } from '../../../../shared/overviews-shared/remotes-panel/remotes-panel.component';
import { ServeCardComponent } from '../../../../shared/components/serve-card/serve-card.component';
import { OverviewHeaderComponent } from '../../../../shared/overviews-shared/overview-header/overview-header.component';
import {
  SchedulerService,
  UiStateService,
  RcloneStatusService,
  AppSettingsService,
  BackendService,
  RemoteFacadeService,
  IconService,
  getRemoteNameFromFs,
} from '@app/services';
import { FormatRateValuePipe } from '../../../../shared/pipes/format-rate-value.pipe';
import { FormatBytes } from '../../../../shared/pipes/format-bytes.pipe';

const SCROLL_DELAY_MS = 60;

const TASK_META: Record<string, { icon: string; colorClass: string }> = {
  sync: { icon: 'sync', colorClass: 'sync-color' },
  copy: { icon: 'copy', colorClass: 'copy-color' },
  move: { icon: 'move', colorClass: 'move-color' },
  bisync: { icon: 'right-left', colorClass: 'bisync-color' },
};

const JOB_ICON_MAP: Record<string, string> = {
  sync: 'refresh',
  copy: 'copy',
  move: 'move',
  bisync: 'right-left',
  copy_url: 'copy',
  copy_file: 'copy',
  move_file: 'move',
  rename_file: 'pen',
  rename_dir: 'pen',
  delete_file: 'trash',
  purge: 'trash',
  cleanup: 'broom',
  rmdirs: 'broom',
  upload: 'file-arrow-up',
};

const TOGGLE_ICON: Record<string, string> = {
  enabled: 'pause',
  running: 'pause',
  disabled: 'play',
  failed: 'play',
  stopping: 'stop',
};

const TOGGLE_KEY: Record<string, string> = {
  enabled: 'disable',
  running: 'disable',
  disabled: 'enable',
  failed: 'enable',
  stopping: 'stopping',
};

export type PanelId = 'remotes' | 'bandwidth' | 'system' | 'jobs' | 'tasks' | 'serves';

interface PanelConfig {
  id: PanelId;
  title: string;
  defaultVisible: boolean;
}

export interface DashboardPanel extends PanelConfig {
  visible: boolean;
}

interface BandwidthDetailItem {
  labelKey: string;
  bytesPerSec: number | undefined;
}

interface JobStatItem {
  labelKey: string;
  value: string | number;
  error?: boolean;
  formatAsBytes?: boolean;
}

const ALL_PANELS: PanelConfig[] = [
  { id: 'remotes', title: 'generalOverview.panels.remotes', defaultVisible: true },
  { id: 'bandwidth', title: 'generalOverview.panels.bandwidth', defaultVisible: true },
  { id: 'system', title: 'generalOverview.panels.system', defaultVisible: true },
  { id: 'jobs', title: 'generalOverview.panels.jobs', defaultVisible: true },
  { id: 'tasks', title: 'generalOverview.panels.tasks', defaultVisible: true },
  { id: 'serves', title: 'generalOverview.panels.serves', defaultVisible: true },
];

@Component({
  selector: 'app-general-overview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgClass,
    DecimalPipe,
    TitleCasePipe,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatExpansionModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatSnackBarModule,
    MatSlideToggleModule,
    DragDropModule,
    FormatTimePipe,
    FormatEtaPipe,
    FormatMemoryUsagePipe,
    RemotesPanelComponent,
    ServeCardComponent,
    FormatRateValuePipe,
    FormatBytes,
    OverviewHeaderComponent,
    TranslateModule,
  ],
  templateUrl: './general-overview.component.html',
  styleUrls: ['./general-overview.component.scss'],
})
export class GeneralOverviewComponent {
  private readonly snackBar = inject(MatSnackBar);
  private readonly schedulerService = inject(SchedulerService);
  private readonly uiStateService = inject(UiStateService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly rcloneStatusService = inject(RcloneStatusService);
  private readonly translate = inject(TranslateService);

  readonly iconService = inject(IconService);
  readonly backendService = inject(BackendService);
  readonly remoteFacade = inject(RemoteFacadeService);

  // --- Outputs ---
  readonly selectRemote = output<Remote>();
  readonly startJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();
  readonly stopJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    serveId?: string;
    profileName?: string;
  }>();
  readonly browseRemote = output<{ remoteName: string; path?: string }>();
  readonly openBackendModal = output<void>();

  // --- State ---
  readonly isEditingLayout = signal(false);
  readonly cardDisplayMode = signal<CardDisplayMode>('compact');
  readonly panelOpenStates = signal<Record<string, boolean>>({
    bandwidth: false,
    system: false,
    jobs: false,
    tasks: false,
    serves: false,
  });
  readonly dashboardPanels = signal<DashboardPanel[]>(
    ALL_PANELS.map(p => ({ ...p, visible: p.defaultVisible }))
  );
  readonly isLoadingScheduledTasks = signal(false);

  readonly scheduledTasks = this.schedulerService.scheduledTasks;

  // --- Service signals re-exposed for the template ---
  readonly rcloneStatus = this.rcloneStatusService.rcloneStatus;
  readonly jobStats = this.rcloneStatusService.jobStats;
  readonly bandwidthLimit = this.rcloneStatusService.bandwidthLimit;
  readonly isLoadingStats = this.rcloneStatusService.isLoading;
  readonly memoryUsage = this.rcloneStatusService.memoryUsage;
  readonly uptime = this.rcloneStatusService.uptime;

  // --- Computed ---
  readonly totalRemotes = computed(() => this.remoteFacade.activeRemotes().length);
  readonly activeJobsCount = computed(
    () => this.remoteFacade.jobs().filter(j => j.status === 'Running').length
  );
  readonly runningJobs = computed(() =>
    this.remoteFacade.jobs().filter(j => j.status === 'Running')
  );
  readonly allRunningServes = computed(() =>
    this.remoteFacade.activeRemotes().flatMap(r => r.status.serve?.serves ?? [])
  );

  readonly jobCompletionPercentage = computed(() => {
    const { totalBytes = 0, bytes = 0 } = this.jobStats();
    return totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  });

  readonly isBandwidthLimited = computed(() => {
    const limit = this.bandwidthLimit();
    return !!limit && limit.rate !== 'off' && limit.rate !== '' && limit.bytesPerSecond > 0;
  });

  readonly activeScheduledTasksCount = computed(
    () => this.scheduledTasks().filter(t => t.status === 'enabled' || t.status === 'running').length
  );

  readonly totalScheduledTasksCount = computed(() => this.scheduledTasks().length);

  readonly bandwidthDetails = computed((): BandwidthDetailItem[] => {
    const limit = this.bandwidthLimit();
    return [
      { labelKey: 'generalOverview.bandwidth.upload', bytesPerSec: limit?.bytesPerSecondTx },
      { labelKey: 'generalOverview.bandwidth.download', bytesPerSec: limit?.bytesPerSecondRx },
      { labelKey: 'generalOverview.bandwidth.total', bytesPerSec: limit?.bytesPerSecond },
    ];
  });

  readonly jobStatsItems = computed((): JobStatItem[] => {
    const s = this.jobStats();
    return [
      { labelKey: 'generalOverview.jobs.speed', value: s.speed, formatAsBytes: true },
      { labelKey: 'generalOverview.jobs.transfers', value: `${s.transfers} / ${s.totalTransfers}` },
      { labelKey: 'generalOverview.jobs.checks', value: `${s.checks} / ${s.totalChecks}` },
      { labelKey: 'generalOverview.jobs.errors', value: s.errors, error: s.errors > 0 },
      { labelKey: 'generalOverview.jobs.deletes', value: s.deletes },
      { labelKey: 'generalOverview.jobs.renames', value: s.renames },
      { labelKey: 'generalOverview.jobs.serverCopies', value: s.serverSideCopies },
      { labelKey: 'generalOverview.jobs.serverMoves', value: s.serverSideMoves },
    ];
  });

  constructor() {
    void this.loadLayoutSettings();
    void this.loadScheduledTasks();
  }

  // --- Layout management ---

  toggleEditLayout(): void {
    this.isEditingLayout.update(v => !v);
  }

  toggleCardDisplayMode(): void {
    this.cardDisplayMode.update(m => (m === 'compact' ? 'detailed' : 'compact'));
    this.persistLayout();
  }

  resetLayout(): void {
    void this.appSettingsService.saveSetting('runtime', 'dashboard_layout', {
      order: [],
      hidden: [],
    });
    void this.appSettingsService.saveSetting('runtime', 'dashboard_card_variant', 'compact');
    this.dashboardPanels.set(ALL_PANELS.map(p => ({ ...p, visible: p.defaultVisible })));
    this.cardDisplayMode.set('compact');
    void this.remoteFacade.saveCurrentLayout(this.backendService.activeBackend(), []);
    this.showSnackbar(this.translate.instant('generalOverview.layout.resetSuccess'));
  }

  resetRemoteLayout(): void {
    void this.remoteFacade.saveCurrentLayout(this.backendService.activeBackend(), []);
    this.showSnackbar(this.translate.instant('generalOverview.layout.resetSuccess'));
  }

  drop(event: CdkDragDrop<DashboardPanel[]>): void {
    this.dashboardPanels.update(panels => {
      const updated = [...panels];
      moveItemInArray(updated, event.previousIndex, event.currentIndex);
      return updated;
    });
    this.persistLayout();
  }

  togglePanelVisibility(panelId: string): void {
    this.dashboardPanels.update(panels =>
      panels.map(p => (p.id === panelId ? { ...p, visible: !p.visible } : p))
    );
    this.persistLayout();
  }

  loadBandwidthLimit(): Promise<void> {
    return this.rcloneStatusService.loadBandwidthLimit();
  }

  protected setPanelOpenState(id: string, isOpen: boolean): void {
    this.panelOpenStates.update(states => ({ ...states, [id]: isOpen }));
  }

  protected getPanelOpenState(id: string): boolean {
    return this.panelOpenStates()[id] ?? false;
  }

  private persistLayout(): void {
    const order = this.dashboardPanels().map(p => p.id);
    const hidden = this.dashboardPanels()
      .filter(p => !p.visible)
      .map(p => p.id);
    void this.appSettingsService.saveSetting('runtime', 'dashboard_layout', { order, hidden });
    void this.appSettingsService.saveSetting(
      'runtime',
      'dashboard_card_variant',
      this.cardDisplayMode()
    );
  }

  // --- Serve actions ---

  stopServe(serve: ServeListItem): void {
    const remoteName = getRemoteNameFromFs(serve.params?.fs);
    if (remoteName) this.stopJob.emit({ type: 'serve', remoteName, serveId: serve.id });
  }

  handleServeCardClick(serve: ServeListItem): void {
    const remoteName = getRemoteNameFromFs(serve.params?.fs);
    if (!remoteName) return;
    const remote = this.remoteFacade.activeRemotes().find(r => r.name === remoteName);
    if (remote) {
      this.uiStateService.setTab('serve');
      this.uiStateService.setSelectedRemote(remote);
      setTimeout(() => this.scrollToTop(), SCROLL_DELAY_MS);
    }
  }

  // --- Task actions ---

  async toggleScheduledTask(taskId: string): Promise<void> {
    try {
      await this.schedulerService.toggleScheduledTask(taskId);
    } catch (error) {
      console.error('Failed to toggle scheduled task:', error);
      this.showSnackbar(this.translate.instant('generalOverview.layout.toggleTaskFailed'));
    }
  }

  onToggleTaskClick(taskId: string, event: Event): void {
    event.stopPropagation();
    void this.toggleScheduledTask(taskId);
  }

  onTaskClick(task: ScheduledTask): void {
    const remoteName = task.args['remote_name'];
    if (remoteName) {
      const remote = this.remoteFacade.activeRemotes().find(r => r.name === remoteName);
      if (remote) this.selectRemote.emit(remote);
    }
  }

  onTaskKeydown(event: KeyboardEvent, task: ScheduledTask): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.onTaskClick(task);
    }
  }

  copyError(error: string): void {
    void navigator.clipboard
      .writeText(error)
      .then(() => this.showSnackbar(this.translate.instant('common.errorCopied')))
      .catch(() => this.showSnackbar(this.translate.instant('common.copyErrorFailed')));
  }

  // --- Task display utilities ---

  getFormattedNextRun(task: ScheduledTask): string {
    if (task.status === 'disabled') return this.translate.instant('task.nextRun.disabled');
    if (task.status === 'stopping') return this.translate.instant('task.nextRun.stopping');
    return task.nextRun
      ? new Date(task.nextRun).toLocaleString()
      : this.translate.instant('task.nextRun.notScheduled');
  }

  getFormattedLastRun(task: ScheduledTask): string {
    return task.lastRun
      ? new Date(task.lastRun).toLocaleString()
      : this.translate.instant('task.lastRun.never');
  }

  getTaskMeta(taskType: string): { icon: string; colorClass: string } {
    return TASK_META[taskType] ?? { icon: 'circle-info', colorClass: '' };
  }

  getToggleKey(status: string): string {
    return TOGGLE_KEY[status] ?? 'enable';
  }

  getToggleIcon(status: string): string {
    return TOGGLE_ICON[status] ?? 'help';
  }

  getJobTypeIcon(job: JobInfo): string {
    return JOB_ICON_MAP[job.job_type] ?? 'folder';
  }

  getJobLabel(job: JobInfo): string {
    const key = `fileBrowser.operations.types.${job.job_type}`;
    const translated = this.translate.instant(key);
    return translated === key ? job.job_type.replace(/_/g, ' ') : translated;
  }

  // --- Private helpers ---

  private async loadLayoutSettings(): Promise<void> {
    try {
      const [savedLayout, savedVariant] = await Promise.all([
        this.appSettingsService.getSettingValue<{ order: string[]; hidden: string[] } | string[]>(
          'runtime.dashboard_layout'
        ),
        this.appSettingsService.getSettingValue<CardDisplayMode>('runtime.dashboard_card_variant'),
      ]);

      if (savedLayout) {
        // Support both the new {order, hidden} shape and the legacy string[] shape
        const order: string[] = Array.isArray(savedLayout)
          ? savedLayout
          : (savedLayout.order ?? []);
        const hiddenIds = new Set<string>(
          Array.isArray(savedLayout) ? [] : (savedLayout.hidden ?? [])
        );

        if (order.length > 0) {
          const ordered = order
            .map(id => ALL_PANELS.find(p => p.id === id))
            .filter((p): p is PanelConfig => !!p)
            .map(p => ({ ...p, visible: !hiddenIds.has(p.id) }));

          // Append any panels not present in the saved order (e.g. newly added panels)
          const seenIds = new Set(order);
          const appended = ALL_PANELS.filter(p => !seenIds.has(p.id)).map(p => ({
            ...p,
            visible: p.defaultVisible,
          }));

          this.dashboardPanels.set([...ordered, ...appended]);
        }
      }

      if (savedVariant) this.cardDisplayMode.set(savedVariant);
    } catch {
      console.debug('Failed to load layout settings, using defaults');
    }
  }

  private async loadScheduledTasks(): Promise<void> {
    this.isLoadingScheduledTasks.set(true);
    try {
      await this.schedulerService.getScheduledTasks();
    } catch (error) {
      console.error('Error loading scheduled tasks:', error);
    } finally {
      this.isLoadingScheduledTasks.set(false);
    }
  }

  private scrollToTop(): void {
    const el = document.querySelector('.main-content') as HTMLElement | null;
    const target = el ?? document.scrollingElement ?? document.documentElement;
    try {
      target.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      (target as HTMLElement).scrollTop = 0;
    }
  }

  private showSnackbar(message: string, duration = 2000): void {
    this.snackBar.open(message, this.translate.instant('common.close'), { duration });
  }
}

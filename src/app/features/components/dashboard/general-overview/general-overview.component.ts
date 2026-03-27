import { NgClass, DecimalPipe, TitleCasePipe } from '@angular/common';
import { Component, OnInit, inject, input, signal, computed, output } from '@angular/core';
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
  RemoteActionProgress,
  ScheduledTask,
  ServeListItem,
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
  IconService,
  getRemoteNameFromFs,
} from '@app/services';
import { FormatRateValuePipe } from '../../../../shared/pipes/format-rate-value.pipe';
import { FormatBytes } from '../../../../shared/pipes/format-bytes.pipe';

const SCROLL_DELAY = 60;

export type PanelId = 'remotes' | 'bandwidth' | 'system' | 'jobs' | 'tasks' | 'serves';

interface PanelConfig {
  id: PanelId;
  title: string;
  defaultVisible: boolean;
}

export interface DashboardPanel extends PanelConfig {
  visible: boolean;
}

interface TaskMeta {
  icon: string;
  colorClass: string;
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
export class GeneralOverviewComponent implements OnInit {
  // --- Services ---
  private readonly snackBar = inject(MatSnackBar);
  private readonly schedulerService = inject(SchedulerService);
  private readonly uiStateService = inject(UiStateService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly rcloneStatusService = inject(RcloneStatusService);
  readonly iconService = inject(IconService);
  readonly backendService = inject(BackendService);
  private readonly translate = inject(TranslateService);

  // --- Inputs ---
  remotes = input<Remote[]>([]);
  jobs = input<JobInfo[]>([]);
  actionInProgress = input<RemoteActionProgress>({});

  // --- Outputs ---
  selectRemote = output<Remote>();
  startJob = output<{ type: PrimaryActionType; remoteName: string }>();
  stopJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    serveId?: string;
    profileName?: string;
  }>();
  browseRemote = output<string>();
  openBackendModal = output<void>();

  // --- State ---
  isEditingLayout = signal(false);

  // FIX: removed dead 'remotes: true' entry — the remotes panel is not a
  // mat-expansion-panel, so getPanelOpenState('remotes') is never called.
  panelOpenStates = signal<Record<string, boolean>>({
    bandwidth: false,
    system: false,
    jobs: false,
    tasks: false,
    serves: false,
  });

  scheduledTasks = this.schedulerService.scheduledTasks;
  isLoadingScheduledTasks = signal(false);

  dashboardPanels = signal<DashboardPanel[]>(
    ALL_PANELS.map(p => ({ ...p, visible: p.defaultVisible }))
  );

  // --- Status service signals re-exposed for template ---
  readonly rcloneStatus = this.rcloneStatusService.rcloneStatus;
  readonly jobStats = this.rcloneStatusService.jobStats;
  readonly bandwidthLimit = this.rcloneStatusService.bandwidthLimit;
  readonly isLoadingStats = this.rcloneStatusService.isLoading;
  readonly memoryUsage = this.rcloneStatusService.memoryUsage;
  readonly uptime = this.rcloneStatusService.uptime;
  readonly loadBandwidthLimit = (): Promise<void> => this.rcloneStatusService.loadBandwidthLimit();

  // --- Computed ---

  readonly totalRemotes = computed(() => this.remotes().length);

  readonly activeJobsCount = computed(
    () => this.jobs().filter(job => job.status === 'Running').length
  );

  readonly allRunningServes = computed(() =>
    this.remotes().flatMap(remote => remote.status.serve?.serves ?? [])
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

  // --- Static lookup tables ---

  private static readonly TASK_META: Record<string, TaskMeta> = {
    sync: { icon: 'sync', colorClass: 'sync-color' },
    copy: { icon: 'copy', colorClass: 'copy-color' },
    move: { icon: 'move', colorClass: 'move-color' },
    bisync: { icon: 'right-left', colorClass: 'bisync-color' },
  };

  private static readonly TOGGLE_ICONS: Record<string, string> = {
    enabled: 'pause',
    running: 'pause',
    disabled: 'play',
    failed: 'play',
    stopping: 'stop',
  };

  private static readonly TOGGLE_KEYS: Record<string, string> = {
    enabled: 'disable',
    running: 'disable',
    disabled: 'enable',
    failed: 'enable',
    stopping: 'stopping',
  };

  ngOnInit(): void {
    this.loadLayoutSettings();
    this.loadScheduledTasks();
  }

  // --- Layout management ---

  toggleEditLayout(): void {
    this.isEditingLayout.update(v => !v);
  }

  resetLayout(): void {
    this.appSettingsService.saveSetting('runtime', 'dashboard_layout', []);
    this.dashboardPanels.set(ALL_PANELS.map(p => ({ ...p, visible: p.defaultVisible })));
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

  private persistLayout(): void {
    const idsToSave = this.dashboardPanels()
      .filter(p => p.visible)
      .map(p => p.id);
    this.appSettingsService.saveSetting('runtime', 'dashboard_layout', idsToSave);
  }

  protected setPanelOpenState(id: string, isOpen: boolean): void {
    this.panelOpenStates.update(states => ({ ...states, [id]: isOpen }));
  }

  protected getPanelOpenState(id: string): boolean {
    return this.panelOpenStates()[id] ?? false;
  }

  // --- Serve actions ---

  async stopServe(serve: ServeListItem): Promise<void> {
    const remoteName = getRemoteNameFromFs(serve.params?.fs);
    if (!remoteName) return;
    this.stopJob.emit({ type: 'serve', remoteName, serveId: serve.id });
  }

  handleServeCardClick(serve: ServeListItem): void {
    const remoteName = getRemoteNameFromFs(serve.params?.fs);
    if (!remoteName) return;
    const remote = this.remotes().find(r => r.name === remoteName);
    if (remote) {
      this.uiStateService.setTab('serve');
      this.uiStateService.setSelectedRemote(remote);
      setTimeout(() => this.scrollToTop(), SCROLL_DELAY);
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

  onTaskClick(task: ScheduledTask): void {
    const remoteName = task.args['remote_name'];
    if (remoteName) {
      const remote = this.remotes().find(r => r.name === remoteName);
      if (remote) this.selectRemote.emit(remote);
    }
  }

  onTaskKeydown(event: KeyboardEvent, task: ScheduledTask): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.onTaskClick(task);
    }
  }

  async copyError(error: string): Promise<void> {
    this.copyToClipboard(
      error,
      this.translate.instant('common.errorCopied'),
      this.translate.instant('common.copyErrorFailed')
    );
  }

  // --- Task utilities ---

  getFormattedNextRun(task: ScheduledTask): string {
    if (task.status === 'disabled') return this.translate.instant('task.nextRun.disabled');
    if (task.status === 'stopping') return this.translate.instant('task.nextRun.stopping');
    if (!task.nextRun) return this.translate.instant('task.nextRun.notScheduled');
    return new Date(task.nextRun).toLocaleString();
  }

  getFormattedLastRun(task: ScheduledTask): string {
    return task.lastRun
      ? new Date(task.lastRun).toLocaleString()
      : this.translate.instant('task.lastRun.never');
  }

  getTaskMeta(taskType: string): TaskMeta {
    return GeneralOverviewComponent.TASK_META[taskType] ?? { icon: 'circle-info', colorClass: '' };
  }

  getToggleKey(status: string): string {
    return GeneralOverviewComponent.TOGGLE_KEYS[status] ?? 'enable';
  }

  getToggleIcon(status: string): string {
    return GeneralOverviewComponent.TOGGLE_ICONS[status] ?? 'help';
  }

  // --- Private helpers ---

  private async loadLayoutSettings(): Promise<void> {
    try {
      const savedIds = await this.appSettingsService.getSettingValue<string[]>(
        'runtime.dashboard_layout'
      );

      if (savedIds && savedIds.length > 0) {
        const orderedPanels: DashboardPanel[] = savedIds
          .map(id => ALL_PANELS.find(p => p.id === id))
          .filter((p): p is PanelConfig => !!p)
          .map(p => ({ ...p, visible: true }));

        const visibleIds = new Set(savedIds);
        const hiddenPanels: DashboardPanel[] = ALL_PANELS.filter(p => !visibleIds.has(p.id)).map(
          p => ({ ...p, visible: false })
        );

        this.dashboardPanels.set([...orderedPanels, ...hiddenPanels]);
      } else {
        this.dashboardPanels.set(ALL_PANELS.map(p => ({ ...p, visible: p.defaultVisible })));
      }
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
      target.scrollTo({ top: 0, behavior: 'smooth' } as ScrollToOptions);
    } catch {
      (target as HTMLElement).scrollTop = 0;
    }
  }

  private async copyToClipboard(
    text: string,
    successMessage: string,
    errorMessage = 'Failed to copy to clipboard'
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.showSnackbar(successMessage);
    } catch (error) {
      console.error('Error copying to clipboard:', error);
      this.showSnackbar(errorMessage);
    }
  }

  private showSnackbar(message: string, action?: string, duration = 2000): void {
    this.snackBar.open(message, action ?? this.translate.instant('common.close'), { duration });
  }
}

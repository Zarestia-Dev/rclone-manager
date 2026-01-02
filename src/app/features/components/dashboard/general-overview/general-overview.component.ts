import { CommonModule } from '@angular/common';
import {
  Component,
  OnInit,
  OnDestroy,
  Output,
  EventEmitter,
  TrackByFunction,
  inject,
  input,
  signal,
  computed,
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

import { catchError, EMPTY, from, Subject, Subscription, switchMap, takeUntil, timer } from 'rxjs';

import {
  BandwidthLimitResponse,
  DEFAULT_JOB_STATS,
  GlobalStats,
  JobInfo,
  MemoryStats,
  PrimaryActionType,
  RcloneStatus,
  Remote,
  RemoteActionProgress,
  SystemStats,
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
  EventListenersService,
  SchedulerService,
  UiStateService,
  SystemInfoService,
  AppSettingsService,
  BackendService,
} from '@app/services';
import { IconService } from '@app/services';
import { FormatRateValuePipe } from '../../../../shared/pipes/format-rate-value.pipe';
import { FormatBytes } from '../../../../shared/pipes/format-bytes.pipe';

const POLLING_INTERVAL = 5000;
const SCROLL_DELAY = 60;

export type PanelId = 'remotes' | 'bandwidth' | 'system' | 'jobs' | 'tasks' | 'serves';

interface PanelConfig {
  id: PanelId;
  title: string;
  defaultVisible: boolean;
}

export interface DashboardPanel extends PanelConfig {
  visible: boolean; // This is the only dynamic part we merge in
}

// The Static Definitions (Source of Truth)
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
    CommonModule,
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
export class GeneralOverviewComponent implements OnInit, OnDestroy {
  // Inputs
  remotes = input<Remote[]>([]);
  jobs = input<JobInfo[]>([]);
  actionInProgress = input<RemoteActionProgress>({});

  // Outputs
  @Output() selectRemote = new EventEmitter<Remote>();
  @Output() startJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();
  @Output() stopJob = new EventEmitter<{
    type: PrimaryActionType;
    remoteName: string;
    serveId?: string;
    profileName?: string;
  }>();
  @Output() browseRemote = new EventEmitter<string>();
  @Output() openBackendModal = new EventEmitter<void>();

  // State signals
  rcloneStatus = signal<RcloneStatus>('inactive');
  systemStats = signal<SystemStats>({ memoryUsage: null, uptime: 0 });
  jobStats = signal<GlobalStats>({ ...DEFAULT_JOB_STATS });
  isLoadingStats = signal(false);
  bandwidthLimit = signal<BandwidthLimitResponse | null>(null);
  isEditingLayout = signal(false);
  panelOpenStates = signal<Record<string, boolean>>({
    remotes: true,
    bandwidth: false,
    system: false,
    jobs: false,
    tasks: false,
    serves: false,
  });
  scheduledTasks = signal<ScheduledTask[]>([]);
  isLoadingScheduledTasks = signal(false);
  isLoadingServes = signal(false);

  dashboardPanels = signal<DashboardPanel[]>(
    ALL_PANELS.map(p => ({ ...p, visible: p.defaultVisible }))
  );

  // Services
  private eventListenersService = inject(EventListenersService);
  private snackBar = inject(MatSnackBar);
  private systemInfoService = inject(SystemInfoService);
  private schedulerService = inject(SchedulerService);
  private uiStateService = inject(UiStateService);
  private appSettingsService = inject(AppSettingsService);
  public iconService = inject(IconService);

  readonly backendService = inject(BackendService);
  private translate = inject(TranslateService);

  // Subscriptions
  private destroy$ = new Subject<void>();
  private pollingSubscription: Subscription | null = null;
  private scheduledTasksSubscription: Subscription | null = null;

  // Track by functions
  readonly trackByPanelId: TrackByFunction<DashboardPanel> = (_, item) => item.id;
  readonly trackByRemoteName: TrackByFunction<Remote> = (_, remote) => remote.remoteSpecs.name;
  readonly trackByIndex: TrackByFunction<unknown> = index => index;

  // Computed values
  totalRemotes = computed(() => this.remotes()?.length || 0);
  activeJobsCount = computed(
    () => this.jobs()?.filter(job => job.status === 'Running').length || 0
  );
  allRunningServes = computed(() =>
    this.remotes().flatMap(remote => remote.serveState?.serves || [])
  );

  jobCompletionPercentage = computed(() => {
    const totalBytes = this.jobStats().totalBytes || 0;
    const bytes = this.jobStats().bytes || 0;
    return totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  });

  isBandwidthLimited = computed(() => {
    const limit = this.bandwidthLimit();
    return !!limit && limit.rate !== 'off' && limit.rate !== '' && limit.bytesPerSecond > 0;
  });

  activeScheduledTasksCount = computed(
    () =>
      this.scheduledTasks().filter(task => task.status === 'enabled' || task.status === 'running')
        .length
  );

  totalScheduledTasksCount = computed(() => this.scheduledTasks().length);

  constructor() {
    this.loadLayoutSettings();
  }

  ngOnInit(): void {
    this.setupTauriListeners();
    this.setupPolling();
    this.loadInitialData();
    this.setupScheduledTasksListener();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // Layout management
  toggleEditLayout(): void {
    const isEditing = this.isEditingLayout();
    this.isEditingLayout.set(!isEditing);
  }

  resetLayout(): void {
    this.appSettingsService.saveSetting('runtime', 'dashboard_layout', null);
    this.dashboardPanels.set(ALL_PANELS.map(p => ({ ...p, visible: p.defaultVisible })));
    this.showSnackbar(this.translate.instant('generalOverview.layout.resetSuccess'));
  }

  drop(event: CdkDragDrop<DashboardPanel[]>): void {
    // Update the panels array in place
    this.dashboardPanels.update(panels => {
      const updated = [...panels];
      moveItemInArray(updated, event.previousIndex, event.currentIndex);
      return updated;
    });

    // Persist to storage (without triggering UI update)
    this.persistLayout();
  }

  togglePanelVisibility(panelId: string): void {
    this.dashboardPanels.update(panels =>
      panels.map(p => (p.id === panelId ? { ...p, visible: !p.visible } : p))
    );
    this.persistLayout();
  }

  private persistLayout(): void {
    // Extract only the visible IDs to save
    const idsToSave = this.dashboardPanels()
      .filter(p => p.visible)
      .map(p => p.id);
    this.appSettingsService.saveSetting('runtime', 'dashboard_layout', idsToSave);
  }

  setPanelOpenState(id: string, isOpen: boolean): void {
    this.panelOpenStates.update(states => ({ ...states, [id]: isOpen }));
  }

  getPanelOpenState(id: string): boolean {
    return this.panelOpenStates()[id] ?? false;
  }

  // Remote actions
  onRemoteSelectedFromPanel(remote: Remote): void {
    this.selectRemote.emit(remote);
  }

  onOpenInFilesFromPanel(remoteName: string): void {
    this.browseRemote.emit(remoteName);
  }

  onSecondaryActionFromPanel(remoteName: string): void {
    this.startJob.emit({ type: 'sync', remoteName });
  }

  // Serve actions
  async stopServe(serve: ServeListItem): Promise<void> {
    const remoteName = serve.params.fs.split(':')[0];
    this.stopJob.emit({ type: 'serve', remoteName, serveId: serve.id });
  }

  handleServeCardClick(serve: ServeListItem): void {
    const remoteName = serve.params.fs.split(':')[0];
    const remote = this.remotes().find(r => r.remoteSpecs.name === remoteName);

    if (remote) {
      this.uiStateService.setTab('serve');
      this.uiStateService.setSelectedRemote(remote);
      setTimeout(() => this.scrollToTop(), SCROLL_DELAY);
    }
  }

  // Task actions
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
      const remote = this.remotes().find(r => r.remoteSpecs.name === remoteName);
      if (remote) {
        this.selectRemote.emit(remote);
      }
    }
  }

  onTaskKeydown(event: KeyboardEvent, task: ScheduledTask): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.onTaskClick(task);
    }
  }

  // Clipboard actions
  handleCopyToClipboard(data: { text: string; message: string }): void {
    this.copyToClipboard(data.text, data.message);
  }

  async copyError(error: string): Promise<void> {
    this.copyToClipboard(
      error,
      this.translate.instant('generalOverview.layout.errorCopied'),
      this.translate.instant('generalOverview.layout.copyErrorFailed')
    );
  }

  // Task utility methods
  getFormattedNextRun(task: ScheduledTask): string {
    if (task.status === 'disabled')
      return this.translate.instant('generalOverview.tasks.disabledMsg');
    if (task.status === 'stopping')
      return this.translate.instant('generalOverview.tasks.stoppingMsg');
    if (!task.nextRun) return this.translate.instant('generalOverview.tasks.notScheduledMsg');
    return new Date(task.nextRun).toLocaleString();
  }

  getFormattedLastRun(task: ScheduledTask): string {
    return task.lastRun
      ? new Date(task.lastRun).toLocaleString()
      : this.translate.instant('generalOverview.tasks.never');
  }

  getTaskTypeIcon(taskType: string): string {
    const iconMap: Record<string, string> = {
      sync: 'sync',
      copy: 'copy',
      move: 'move',
      bisync: 'right-left',
    };
    return iconMap[taskType] || 'circle-info';
  }

  getTaskTypeColor(taskType: string): string {
    const colorMap: Record<string, string> = {
      sync: 'sync-color',
      copy: 'copy-color',
      move: 'move-color',
      bisync: 'bisync-color',
    };
    return colorMap[taskType] || '';
  }

  private readonly TOGGLE_ICONS: Record<string, string> = {
    enabled: 'pause',
    running: 'pause',
    disabled: 'play',
    failed: 'play',
    stopping: 'stop',
  };

  getTaskStatusTooltip(status: string): string {
    return this.translate.instant(`generalOverview.tasks.status.${status}`);
  }

  getToggleTooltip(status: string): string {
    return this.translate.instant(`generalOverview.tasks.toggle.${status}`);
  }

  getToggleIcon(status: string): string {
    return this.TOGGLE_ICONS[status] || 'help';
  }

  // Private methods
  private async loadLayoutSettings(): Promise<void> {
    try {
      const savedIds = await this.appSettingsService.getSettingValue<string[]>(
        'runtime.dashboard_layout'
      );

      if (savedIds && savedIds.length > 0) {
        // 1. Map visible items in order
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

  private cleanup(): void {
    this.stopPolling();
    this.scheduledTasksSubscription?.unsubscribe();
    this.destroy$.next();
    this.destroy$.complete();
  }

  private setupPolling(): void {
    this.stopPolling();
    this.pollingSubscription = timer(0, POLLING_INTERVAL)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => from(this.loadSystemStats()).pipe(catchError(() => EMPTY)))
      )
      .subscribe();
  }
  private stopPolling(): void {
    this.pollingSubscription?.unsubscribe();
    this.pollingSubscription = null;
  }

  private async loadInitialData(): Promise<void> {
    await Promise.all([this.checkRcloneStatus(), this.loadBandwidthLimit()]);
  }

  private async checkRcloneStatus(): Promise<void> {
    try {
      const rcloneInfo = await this.systemInfoService.getRcloneInfo();
      this.rcloneStatus.set(rcloneInfo ? 'active' : 'inactive');
    } catch {
      this.rcloneStatus.set('error');
    }
  }

  private async loadSystemStats(): Promise<void> {
    const hasData = this.systemStats().uptime > 0 || this.systemStats().memoryUsage !== null;

    if (!hasData) {
      this.isLoadingStats.set(true);
    }

    try {
      const [memoryStats, coreStats] = await Promise.all([
        this.systemInfoService.getMemoryStats().catch(() => null as MemoryStats | null),
        this.systemInfoService.getCoreStats().catch(() => null as GlobalStats | null),
      ]);

      this.updateSystemStats(memoryStats, coreStats);
      await this.checkRcloneStatus();
    } catch (error) {
      console.error('Error loading system stats:', error);
      if (!hasData) {
        this.resetStats();
      }
    } finally {
      this.isLoadingStats.set(false);
    }
  }

  private updateSystemStats(memoryStats: MemoryStats | null, coreStats: GlobalStats | null): void {
    if (coreStats) {
      this.jobStats.update(stats => ({ ...stats, ...coreStats }));
      this.systemStats.set({
        memoryUsage: memoryStats,
        uptime: coreStats.elapsedTime || 0,
      });
    } else {
      this.resetStats();
      this.systemStats.update(stats => ({ ...stats, memoryUsage: memoryStats }));
    }
  }

  private resetStats(): void {
    this.jobStats.set({ ...DEFAULT_JOB_STATS });
    this.systemStats.set({ memoryUsage: null, uptime: 0 });
  }

  private setupTauriListeners(): void {
    this.eventListenersService
      .listenToBandwidthLimitChanged()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: async () => {
          const limit = await this.systemInfoService
            .getBandwidthLimit()
            .catch(() => null as BandwidthLimitResponse | null);
          this.bandwidthLimit.set(limit);
        },
      });
  }

  private setupScheduledTasksListener(): void {
    this.loadScheduledTasks();
    this.scheduledTasksSubscription = this.schedulerService.scheduledTasks$
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (tasks: ScheduledTask[]) => this.scheduledTasks.set(tasks),
      });
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

  async loadBandwidthLimit(): Promise<void> {
    try {
      if (!this.bandwidthLimit()) {
        this.bandwidthLimit.set({
          bytesPerSecond: 0,
          bytesPerSecondRx: 0,
          bytesPerSecondTx: 0,
          rate: 'Loading...',
          loading: true,
        });
      }

      const response = await this.systemInfoService
        .getBandwidthLimit()
        .catch(() => null as BandwidthLimitResponse | null);

      this.bandwidthLimit.set(response);
    } catch (error) {
      this.bandwidthLimit.set({
        bytesPerSecond: -1,
        bytesPerSecondRx: -1,
        bytesPerSecondTx: -1,
        rate: 'off',
        loading: false,
        error: `Failed to load bandwidth limit: ${error}`,
      });
    }
  }

  // Utility methods
  private scrollToTop(): void {
    const el = document.querySelector('.main-content') as HTMLElement | null;
    const target = el || document.scrollingElement || document.documentElement;

    try {
      target.scrollTo({ top: 0, behavior: 'smooth' } as ScrollToOptions);
    } catch {
      (target as HTMLElement).scrollTop = 0;
    }
  }

  private copyToClipboard(
    text: string,
    successMessage: string,
    errorMessage = 'Failed to copy to clipboard' // Fallback only, usually provided by caller
  ): void {
    try {
      navigator.clipboard.writeText(text);
      this.showSnackbar(successMessage);
    } catch (error) {
      console.error('Error copying to clipboard:', error);
      this.showSnackbar(errorMessage);
    }
  }

  private showSnackbar(message: string, action?: string, duration = 2000): void {
    this.snackBar.open(message, action || this.translate.instant('common.close'), { duration });
  }
}

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
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBarModule, MatSnackBar } from '@angular/material/snack-bar';
import {
  catchError,
  EMPTY,
  filter,
  from,
  Subject,
  Subscription,
  switchMap,
  takeUntil,
  timer,
} from 'rxjs';

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
} from '@app/types';
import { FormatTimePipe } from '../../../../shared/pipes/format-time.pipe';
import { FormatEtaPipe } from '../../../../shared/pipes/format-eta.pipe';
import { FormatMemoryUsagePipe } from '../../../../shared/pipes/format-memory-usage.pipe';
import { RemotesPanelComponent } from '../../../../shared/overviews-shared/remotes-panel/remotes-panel.component';

// Services
import { AnimationsService } from '../../../../shared/services/animations.service';
import { EventListenersService, SchedulerService, UiStateService } from '@app/services';
import { SystemInfoService } from '@app/services';
import { FormatBytes } from '@app/pipes';
import { IconService } from 'src/app/shared/services/icon.service';
import { ScheduledTask, ServeListItem } from '@app/types';
import { ServeCardComponent } from '../../../../shared/components/serve-card/serve-card.component';

/** Polling interval for system stats in milliseconds */
const POLLING_INTERVAL = 5000;

/**
 * GeneralOverviewComponent displays an overview of RClone remotes and system information
 */
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
    FormatTimePipe,
    FormatEtaPipe,
    FormatMemoryUsagePipe,
    FormatBytes,
    RemotesPanelComponent,
    ServeCardComponent,
  ],
  templateUrl: './general-overview.component.html',
  styleUrls: ['./general-overview.component.scss'],
  animations: [AnimationsService.fadeInOut()],
})
export class GeneralOverviewComponent implements OnInit, OnDestroy {
  // Input/Output Properties
  remotes = input<Remote[]>([]);
  jobs = input<JobInfo[]>([]);
  actionInProgress = input<RemoteActionProgress>({});

  @Output() selectRemote = new EventEmitter<Remote>();
  @Output() startJob = new EventEmitter<{
    type: PrimaryActionType;
    remoteName: string;
  }>();
  @Output() stopJob = new EventEmitter<{
    type: PrimaryActionType;
    remoteName: string;
    serveId?: string;
  }>();
  @Output() browseRemote = new EventEmitter<string>();

  // Component State
  rcloneStatus = signal<RcloneStatus>('inactive');
  systemStats = signal<SystemStats>({ memoryUsage: null, uptime: 0 });
  jobStats = signal<GlobalStats>({ ...DEFAULT_JOB_STATS });
  isLoadingStats = signal(false);

  // Panel states
  bandwidthLimit = signal<BandwidthLimitResponse | null>(null);
  bandwidthPanelOpenState = signal(false);
  systemInfoPanelOpenState = signal(false);
  jobInfoPanelOpenState = signal(false);
  scheduledTasksPanelOpenState = signal(false);
  servesPanelOpenState = signal(false);

  // Scheduled tasks
  scheduledTasks = signal<ScheduledTask[]>([]);
  isLoadingScheduledTasks = signal(false);

  // Running serves
  isLoadingServes = signal(false);

  // Private members
  private eventListenersService = inject(EventListenersService);
  private destroy$ = new Subject<void>();
  private pollingSubscription: Subscription | null = null;
  private scheduledTasksSubscription: Subscription | null = null;

  // Services
  private snackBar = inject(MatSnackBar);
  private systemInfoService = inject(SystemInfoService);
  private schedulerService = inject(SchedulerService);
  private uiStateService = inject(UiStateService);
  public iconService = inject(IconService);

  // Track by functions
  readonly trackByRemoteName: TrackByFunction<Remote> = (_, remote) => remote.remoteSpecs.name;
  readonly trackByIndex: TrackByFunction<unknown> = index => index;

  ngOnInit(): void {
    this.setupTauriListeners();
    this.setupPolling();
    this.loadInitialData();
    this.setupScheduledTasksListener();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // Private methods
  private cleanup(): void {
    this.stopPolling();
    if (this.scheduledTasksSubscription) {
      this.scheduledTasksSubscription.unsubscribe();
      this.scheduledTasksSubscription = null;
    }
    this.destroy$.next();
    this.destroy$.complete();
  }

  private setupPolling(): void {
    this.stopPolling();

    this.pollingSubscription = timer(0, POLLING_INTERVAL)
      .pipe(
        takeUntil(this.destroy$),
        filter(() => !this.isLoadingStats()),
        switchMap(() =>
          from(this.loadSystemStats()).pipe(
            catchError(err => {
              console.error('Error in system stats polling:', err);
              return EMPTY;
            })
          )
        )
      )
      .subscribe();
  }

  private stopPolling(): void {
    if (this.pollingSubscription) {
      this.pollingSubscription.unsubscribe();
      this.pollingSubscription = null;
    }
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

  primaryActions = computed<PrimaryActionType[]>(() =>
    this.remotes().flatMap(remote => remote.primaryActions || [])
  );

  private async loadSystemStats(): Promise<void> {
    if (this.isLoadingStats()) return;

    this.isLoadingStats.set(true);

    try {
      const [memoryStats, coreStats] = await Promise.all([
        this.systemInfoService.getMemoryStats().catch(() => null as MemoryStats | null),
        this.systemInfoService.getCoreStats().catch(err => {
          console.error('Error loading core stats:', err);
          return null as GlobalStats | null;
        }),
      ]);

      this.updateSystemStats(memoryStats, coreStats);
      this.checkRcloneStatus();
    } catch (error) {
      console.error('Error loading system stats:', error);
      this.jobStats.set({ ...DEFAULT_JOB_STATS });
      this.systemStats.set({ memoryUsage: null, uptime: 0 });
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
      this.jobStats.set({ ...DEFAULT_JOB_STATS });
      this.systemStats.set({ memoryUsage: memoryStats, uptime: 0 });
    }
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
        next: (tasks: ScheduledTask[]) => {
          this.scheduledTasks.set(tasks);
        },
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

  async stopServe(serve: ServeListItem): Promise<void> {
    const remoteName = serve.params.fs.split(':')[0];
    this.stopJob.emit({ type: 'serve', remoteName, serveId: serve.id });
  }

  handleCopyToClipboard(data: { text: string; message: string }): void {
    try {
      navigator.clipboard.writeText(data.text);
      this.snackBar.open(data.message, 'Close', { duration: 2000 });
    } catch (error) {
      console.error('Error copying to clipboard:', error);
      this.snackBar.open('Failed to copy to clipboard', 'Close', { duration: 2000 });
    }
  }

  handleServeCardClick(serve: ServeListItem): void {
    const remoteName = serve.params.fs.split(':')[0];
    const remote = this.remotes().find(r => r.remoteSpecs.name === remoteName);
    if (remote) {
      this.uiStateService.setTab('serve');
      this.uiStateService.setSelectedRemote(remote);
      setTimeout(() => {
        const el = document.querySelector('.main-content') as HTMLElement | null;
        const target = el || document.scrollingElement || document.documentElement;
        try {
          target.scrollTo({ top: 0, behavior: 'smooth' } as ScrollToOptions);
        } catch {
          (target as HTMLElement).scrollTop = 0;
        }
      }, 60);
    }
  }

  isBandwidthLimited = computed(() => {
    const limit = this.bandwidthLimit();
    if (!limit) return false;
    return !!limit && limit.rate !== 'off' && limit.rate !== '' && limit.bytesPerSecond > 0;
  });

  bandwidthDisplayValue = computed(() => {
    const limit = this.bandwidthLimit();
    if (limit?.loading) return 'Loading...';
    if (limit?.error) return 'Error loading limit';
    if (!limit || limit.rate === 'off' || limit.rate === '' || limit.bytesPerSecond <= 0) {
      return 'Unlimited';
    }
    return limit.rate;
  });

  bandwidthDetails = computed(() => {
    const limit = this.bandwidthLimit();
    if (!limit) return { upload: 0, download: 0, total: 0 };
    const isUnlimited = (value: number): boolean => value <= 0;
    return {
      upload: isUnlimited(limit.bytesPerSecondTx) ? 0 : limit.bytesPerSecondTx,
      download: isUnlimited(limit.bytesPerSecondRx) ? 0 : limit.bytesPerSecondRx,
      total: isUnlimited(limit.bytesPerSecond) ? 0 : limit.bytesPerSecond,
    };
  });

  async loadBandwidthLimit(): Promise<void> {
    try {
      this.bandwidthLimit.set({
        bytesPerSecond: 0,
        bytesPerSecondRx: 0,
        bytesPerSecondTx: 0,
        rate: 'Loading...',
        loading: true,
      });

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

  // Event handlers for remotes panel
  onRemoteSelectedFromPanel(remote: Remote): void {
    this.selectRemote.emit(remote);
  }

  onOpenInFilesFromPanel(remoteName: string): void {
    this.browseRemote.emit(remoteName);
  }

  onSecondaryActionFromPanel(remoteName: string): void {
    // Secondary action could be sync operation
    this.startJob.emit({ type: 'sync', remoteName });
  }

  // Copy error to clipboard
  async copyError(error: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(error);
      this.snackBar.open('Error copied to clipboard', 'Close', {
        duration: 2000,
      });
    } catch {
      this.snackBar.open('Failed to copy error', 'Close', {
        duration: 2000,
      });
    }
  }

  // Scheduled tasks helpers
  activeScheduledTasksCount = computed(
    () =>
      this.scheduledTasks().filter(task => task.status === 'enabled' || task.status === 'running')
        .length
  );

  totalScheduledTasksCount = computed(() => this.scheduledTasks().length);

  getTasksByRemote(remoteName: string): ScheduledTask[] {
    return this.scheduledTasks().filter(task => task.args['remoteName'] === remoteName);
  }

  getFormattedNextRun(task: ScheduledTask): string {
    if (task.status === 'disabled') {
      return 'Task is disabled';
    }
    if (task.status === 'stopping') {
      return 'Disabling after current run';
    }
    if (!task.nextRun) return 'Not scheduled';
    return new Date(task.nextRun).toLocaleString();
  }

  getFormattedLastRun(task: ScheduledTask): string {
    if (!task.lastRun) return 'Never';
    return new Date(task.lastRun).toLocaleString();
  }

  async toggleScheduledTask(taskId: string): Promise<void> {
    try {
      await this.schedulerService.toggleScheduledTask(taskId);
    } catch (error) {
      console.error('Error toggling scheduled task:', error);
      this.snackBar.open('Failed to toggle scheduled task', 'Close', {
        duration: 2000,
      });
    }
  }

  // Navigate to remote details when task is clicked
  onTaskClick(task: ScheduledTask): void {
    const remoteName = task.args['remote_name'];
    if (remoteName) {
      const remote = this.remotes().find(r => r.remoteSpecs.name === remoteName);
      if (remote) {
        this.selectRemote.emit(remote);
      }
    }
  }

  // Handle keyboard navigation for task cards
  onTaskKeydown(event: KeyboardEvent, task: ScheduledTask): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.onTaskClick(task);
    }
  }

  // Get task type icon
  getTaskTypeIcon(taskType: string): string {
    switch (taskType) {
      case 'sync':
        return 'sync';
      case 'copy':
        return 'copy';
      case 'move':
        return 'move';
      case 'bisync':
        return 'right-left';
      default:
        return 'circle-info';
    }
  }

  // Get task type color class
  getTaskTypeColor(taskType: string): string {
    switch (taskType) {
      case 'sync':
        return 'sync-color';
      case 'copy':
        return 'copy-color';
      case 'move':
        return 'move-color';
      case 'bisync':
        return 'bisync-color';
      default:
        return '';
    }
  }

  getTaskStatusTooltip(status: string): string {
    switch (status) {
      case 'enabled':
        return 'Task is enabled and will run on schedule.';
      case 'disabled':
        return 'Task is disabled and will not run.';
      case 'running':
        return 'Task is currently running.';
      case 'failed':
        return 'Task failed on its last run.';
      case 'stopping':
        return 'Task is stopping and will be disabled after the current run finishes.';
      default:
        return '';
    }
  }

  getToggleTooltip(status: string): string {
    switch (status) {
      case 'enabled':
      case 'running':
        return 'Disable task';
      case 'disabled':
      case 'failed':
        return 'Enable task';
      case 'stopping':
        return 'Task is stopping...';
      default:
        return '';
    }
  }

  getToggleIcon(status: string): string {
    switch (status) {
      case 'enabled':
      case 'running':
        return 'pause';
      case 'disabled':
      case 'failed':
        return 'play';
      case 'stopping':
        return 'stop';
      default:
        return 'help';
    }
  }
}

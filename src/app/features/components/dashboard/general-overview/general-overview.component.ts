import { NgClass, DecimalPipe, TitleCasePipe } from '@angular/common';
import { Component, OnInit, inject, input, signal, computed, output } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
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
} from '@app/services';
import { IconService } from '@app/services';
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
  // Services
  private snackBar = inject(MatSnackBar);
  private schedulerService = inject(SchedulerService);
  private uiStateService = inject(UiStateService);
  private appSettingsService = inject(AppSettingsService);
  public rcloneStatusService = inject(RcloneStatusService);
  public iconService = inject(IconService);

  readonly backendService = inject(BackendService);
  private translate = inject(TranslateService);

  // Inputs
  remotes = input<Remote[]>([]);
  jobs = input<JobInfo[]>([]);
  actionInProgress = input<RemoteActionProgress>({});

  // Outputs
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

  // State signals
  isEditingLayout = signal(false);
  panelOpenStates = signal<Record<string, boolean>>({
    remotes: true,
    bandwidth: false,
    system: false,
    jobs: false,
    tasks: false,
    serves: false,
  });
  scheduledTasks = toSignal(this.schedulerService.scheduledTasks$, { initialValue: [] });
  isLoadingScheduledTasks = signal(false);
  isLoadingServes = signal(false);

  dashboardPanels = signal<DashboardPanel[]>(
    ALL_PANELS.map(p => ({ ...p, visible: p.defaultVisible }))
  );

  // Expose status service signals for template
  readonly rcloneStatus = this.rcloneStatusService.rcloneStatus;
  readonly jobStats = this.rcloneStatusService.jobStats;
  readonly bandwidthLimit = this.rcloneStatusService.bandwidthLimit;
  readonly systemStats = computed(() => ({
    memoryUsage: this.rcloneStatusService.memoryUsage(),
    uptime: this.rcloneStatusService.uptime(),
  }));
  readonly isLoadingStats = this.rcloneStatusService.isLoading;

  // No manual subscriptions needed anymore

  // Track by functions
  readonly trackByIndex: (index: number) => number = index => index;

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
    this.loadScheduledTasks();
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
      this.translate.instant('common.errorCopied'),
      this.translate.instant('common.copyErrorFailed')
    );
  }

  // Task utility methods
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
    return this.translate.instant(`task.status.${status}`);
  }

  getToggleTooltip(status: string): string {
    let key = 'enable'; // Default to enable
    if (status === 'enabled' || status === 'running') {
      key = 'disable';
    } else if (status === 'stopping') {
      key = 'stopping';
    }
    return this.translate.instant(`task.toggle.${key}`);
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
    this.snackBar.open(message, action || this.translate.instant('common.close'), { duration });
  }
}

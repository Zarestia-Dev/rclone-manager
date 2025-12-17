import {
  Component,
  EventEmitter,
  Output,
  inject,
  input,
  signal,
  computed,
  effect,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { CommonModule } from '@angular/common';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTableModule } from '@angular/material/table';
import { MatSortModule } from '@angular/material/sort';
import {
  DiskUsage,
  JobInfo,
  JobsPanelConfig,
  PrimaryActionType,
  Remote,
  RemoteSettings,
  SettingsPanelConfig,
  ScheduledTask,
} from '@app/types';
import {
  DiskUsagePanelComponent,
  JobsPanelComponent,
  SettingsPanelComponent,
} from '../../../../shared/detail-shared';
import { IconService } from 'src/app/shared/services/icon.service';
import { SchedulerService } from '@app/services';

interface ActionConfig {
  key: PrimaryActionType;
  label: string;
  icon: string;
  getTooltip: (remote: Remote) => string;
  getActiveState: (remote: Remote) => boolean;
}

const ACTION_CONFIGS: ActionConfig[] = [
  {
    key: 'mount',
    label: 'Mount',
    icon: 'mount',
    getTooltip: remote => (remote.mountState?.mounted ? 'Mounted' : 'Toggle Mount as Quick Action'),
    getActiveState: remote => remote.mountState?.mounted || false,
  },
  {
    key: 'sync',
    label: 'Sync',
    icon: 'sync',
    getTooltip: remote => (remote.syncState?.isOnSync ? 'Syncing' : 'Toggle Sync as Quick Action'),
    getActiveState: remote => remote.syncState?.isOnSync || false,
  },
  {
    key: 'copy',
    label: 'Copy',
    icon: 'copy',
    getTooltip: remote => (remote.copyState?.isOnCopy ? 'Copying' : 'Toggle Copy as Quick Action'),
    getActiveState: remote => remote.copyState?.isOnCopy || false,
  },
  {
    key: 'move',
    label: 'Move',
    icon: 'move',
    getTooltip: remote => (remote.moveState?.isOnMove ? 'Moving' : 'Toggle Move as Quick Action'),
    getActiveState: remote => remote.moveState?.isOnMove || false,
  },
  {
    key: 'bisync',
    label: 'Bisync',
    icon: 'right-left',
    getTooltip: remote =>
      remote.bisyncState?.isOnBisync ? 'Bisync Active' : 'Toggle BiSync as Quick Action',
    getActiveState: remote => remote.bisyncState?.isOnBisync || false,
  },
  {
    key: 'serve',
    label: 'Serve',
    icon: 'serve',
    getTooltip: remote =>
      remote.serveState?.isOnServe ? 'Serving' : 'Toggle Serve as Quick Action',
    getActiveState: remote => remote.serveState?.isOnServe || false,
  },
];

@Component({
  selector: 'app-general-detail',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
    MatDividerModule,
    MatTooltipModule,
    MatChipsModule,
    MatButtonModule,
    MatTableModule,
    MatSortModule,
    SettingsPanelComponent,
    DiskUsagePanelComponent,
    JobsPanelComponent,
  ],
  templateUrl: './general-detail.component.html',
  styleUrl: './general-detail.component.scss',
})
export class GeneralDetailComponent {
  readonly iconService = inject(IconService);
  private readonly schedulerService = inject(SchedulerService);

  // Inputs
  selectedRemote = input.required<Remote>();
  jobs = input<JobInfo[]>([]);
  restrictMode = input.required<boolean>();

  // Outputs
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
  }>();
  @Output() stopJob = new EventEmitter<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();
  @Output() deleteJob = new EventEmitter<number>();
  @Output() togglePrimaryAction = new EventEmitter<PrimaryActionType>();

  // Component State
  private allScheduledTasks = toSignal(this.schedulerService.scheduledTasks$, { initialValue: [] });
  remoteScheduledTasks = signal<ScheduledTask[]>([]);
  currentTaskCardIndex = signal(0);

  readonly displayedColumns: string[] = [
    'type',
    'profile',
    'status',
    'progress',
    'startTime',
    'actions',
  ];
  readonly maxPrimaryActions = 3;
  readonly actionConfigs = ACTION_CONFIGS;

  constructor() {
    // Initial load of all tasks
    this.schedulerService.getScheduledTasks().catch(err => {
      console.error('Error loading scheduled tasks:', err);
    });

    // Effect to filter tasks when the selected remote or all tasks change
    effect(() => {
      const allTasks = this.allScheduledTasks();
      const remote = this.selectedRemote();
      if (!remote) {
        this.remoteScheduledTasks.set([]);
        this.currentTaskCardIndex.set(0);
        return;
      }
      const filteredTasks = allTasks.filter(
        task => task.args['remote_name'] === remote.remoteSpecs.name
      );
      this.remoteScheduledTasks.set(filteredTasks);

      if (this.currentTaskCardIndex() >= filteredTasks.length) {
        this.currentTaskCardIndex.set(0);
      }
    });
  }

  // Action status methods
  isActionSelected(actionKey: PrimaryActionType): boolean {
    return this.selectedRemote()?.primaryActions?.includes(actionKey) || false;
  }

  isActionActive(actionKey: PrimaryActionType): boolean {
    const config = this.actionConfigs.find(c => c.key === actionKey);
    return config?.getActiveState(this.selectedRemote()) || false;
  }

  getActionPosition(actionKey: PrimaryActionType): number {
    return (this.selectedRemote()?.primaryActions?.indexOf(actionKey) ?? -1) + 1;
  }

  getActionTooltip(actionKey: PrimaryActionType): string {
    const config = this.actionConfigs.find(c => c.key === actionKey);
    return config?.getTooltip(this.selectedRemote()) || '';
  }

  canSelectMoreActions = computed(() => {
    return (this.selectedRemote()?.primaryActions?.length || 0) < this.maxPrimaryActions;
  });

  onToggleAction(actionKey: PrimaryActionType): void {
    if (this.isActionSelected(actionKey) || this.canSelectMoreActions()) {
      this.togglePrimaryAction.emit(actionKey);
    }
  }

  // Computed configurations for shared components
  remoteConfigurationPanelConfig = computed<SettingsPanelConfig>(() => ({
    section: {
      key: 'remote-config',
      title: 'Remote Configuration',
      icon: 'wrench',
    },
    settings: this.selectedRemote().remoteSpecs,
    hasSettings: Object.keys(this.selectedRemote().remoteSpecs).length > 0,
    restrictMode: this.restrictMode(),
    buttonColor: 'primary',
    buttonLabel: 'Edit Configuration',
  }));

  diskUsageConfig = computed<DiskUsage>(() => this.selectedRemote()?.diskUsage);

  jobsPanelConfig = computed<JobsPanelConfig>(() => ({
    jobs: this.jobs(),
    displayedColumns: this.displayedColumns,
  }));

  onEditRemoteConfiguration(): void {
    this.openRemoteConfigModal.emit({
      editTarget: 'remote',
      existingConfig: this.selectedRemote().remoteSpecs as unknown as RemoteSettings, //TODO: Fix this
    });
  }

  // Accessibility helpers
  getAriaLabel(actionKey: PrimaryActionType): string {
    const config = this.actionConfigs.find(c => c.key === actionKey);
    const isSelected = this.isActionSelected(actionKey);
    const position = this.getActionPosition(actionKey);

    if (isSelected && position > 0) {
      return `${config?.label} selected as quick action ${position}`;
    }

    return `Toggle ${config?.label} as quick action`;
  }

  // Track by functions
  trackByActionKey(index: number, config: ActionConfig): PrimaryActionType {
    return config.key;
  }

  trackByTaskId(index: number, task: ScheduledTask): string {
    return task.id;
  }

  // Computed properties for scheduled tasks
  hasScheduledTasks = computed(() => this.remoteScheduledTasks().length > 0);
  currentTask = computed(() => this.remoteScheduledTasks()[this.currentTaskCardIndex()] || null);

  // Methods for scheduled tasks
  getFormattedNextRun(task: ScheduledTask): string {
    if (task.status === 'disabled') return 'Task is disabled';
    if (task.status === 'stopping') return 'Disabling after current run';
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
    }
  }

  nextTaskCard(): void {
    this.currentTaskCardIndex.update(i => (i < this.remoteScheduledTasks().length - 1 ? i + 1 : i));
  }

  previousTaskCard(): void {
    this.currentTaskCardIndex.update(i => (i > 0 ? i - 1 : i));
  }

  goToTaskCard(index: number): void {
    this.currentTaskCardIndex.set(index);
  }

  // Tooltip and icon helpers
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

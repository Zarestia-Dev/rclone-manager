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
import { IconService, SchedulerService } from '@app/services';

import { TranslateModule, TranslateService } from '@ngx-translate/core';

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
    label: 'actions.mount',
    icon: 'mount',
    getTooltip: remote => (remote.mountState?.mounted ? 'mount.mounted' : 'mount.toggleAction'),
    getActiveState: remote => remote.mountState?.mounted || false,
  },
  {
    key: 'sync',
    label: 'actions.sync',
    icon: 'sync',
    getTooltip: remote => (remote.syncState?.isOnSync ? 'sync.syncing' : 'sync.toggleSync'),
    getActiveState: remote => remote.syncState?.isOnSync || false,
  },
  {
    key: 'copy',
    label: 'actions.copy',
    icon: 'copy',
    getTooltip: remote => (remote.copyState?.isOnCopy ? 'sync.copying' : 'sync.toggleCopy'),
    getActiveState: remote => remote.copyState?.isOnCopy || false,
  },
  {
    key: 'move',
    label: 'actions.move',
    icon: 'move',
    getTooltip: remote => (remote.moveState?.isOnMove ? 'sync.moving' : 'sync.toggleMove'),
    getActiveState: remote => remote.moveState?.isOnMove || false,
  },
  {
    key: 'bisync',
    label: 'actions.bisync',
    icon: 'right-left',
    getTooltip: remote =>
      remote.bisyncState?.isOnBisync ? 'sync.bisyncActive' : 'sync.toggleBisync',
    getActiveState: remote => remote.bisyncState?.isOnBisync || false,
  },
  {
    key: 'serve',
    label: 'actions.serve',
    icon: 'serve',
    getTooltip: remote => (remote.serveState?.isOnServe ? 'serve.serving' : 'serve.toggleAction'),
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
    TranslateModule,
  ],
  templateUrl: './general-detail.component.html',
  styleUrl: './general-detail.component.scss',
})
export class GeneralDetailComponent {
  readonly iconService = inject(IconService);
  private readonly schedulerService = inject(SchedulerService);
  private readonly translate = inject(TranslateService);

  // Inputs
  selectedRemote = input.required<Remote>();
  jobs = input<JobInfo[]>([]);

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

  private readonly TASK_TYPE_ICONS: Record<string, string> = {
    sync: 'sync',
    copy: 'copy',
    move: 'move',
    bisync: 'right-left',
  };

  getTaskTypeIcon(taskType: string): string {
    return this.TASK_TYPE_ICONS[taskType] || 'circle-info';
  }

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
      title: 'dashboard.generalDetail.remoteConfiguration',
      icon: 'wrench',
    },
    settings: this.selectedRemote().remoteSpecs,
    hasSettings: Object.keys(this.selectedRemote().remoteSpecs).length > 0,
    buttonColor: 'primary',
    buttonLabel: 'dashboard.generalDetail.editConfiguration',
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

    const label = this.translate.instant(config?.label || '');

    if (isSelected && position > 0) {
      return this.translate.instant('dashboard.generalDetail.quickActionSelected', {
        label,
        position,
      });
    }

    return this.translate.instant('dashboard.generalDetail.toggleQuickAction', { label });
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
    if (task.status === 'disabled') return this.translate.instant('task.nextRun.disabled');
    if (task.status === 'stopping') return this.translate.instant('task.nextRun.stopping');
    if (!task.nextRun) return this.translate.instant('task.nextRun.notScheduled');
    return new Date(task.nextRun).toLocaleString();
  }

  getFormattedLastRun(task: ScheduledTask): string {
    if (!task.lastRun) return this.translate.instant('task.lastRun.never');
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

  private readonly TASK_STATUS_TOOLTIPS: Record<string, string> = {
    enabled: 'task.status.enabled',
    disabled: 'task.status.disabled',
    running: 'task.status.running',
    failed: 'task.status.failed',
    stopping: 'task.status.stopping',
  };

  private readonly TOGGLE_TOOLTIPS: Record<string, string> = {
    enabled: 'task.toggle.disable',
    running: 'task.toggle.disable',
    disabled: 'task.toggle.enable',
    failed: 'task.toggle.enable',
    stopping: 'task.toggle.stopping',
  };

  private readonly TOGGLE_ICONS: Record<string, string> = {
    enabled: 'pause',
    running: 'pause',
    disabled: 'play',
    failed: 'play',
    stopping: 'stop',
  };

  // Tooltip and icon helpers
  getTaskStatusTooltip(status: string): string {
    return this.TASK_STATUS_TOOLTIPS[status] || '';
  }

  getToggleTooltip(status: string): string {
    return this.TOGGLE_TOOLTIPS[status] || '';
  }

  getToggleIcon(status: string): string {
    return this.TOGGLE_ICONS[status] || 'help';
  }
}

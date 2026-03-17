import { Component, inject, input, signal, computed, output, effect } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { NgClass, TitleCasePipe, DatePipe } from '@angular/common';
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

interface ActionViewModel {
  key: PrimaryActionType;
  label: string;
  icon: string;
  isSelected: boolean;
  isActive: boolean;
  /** 1-based position in primaryActions, 0 when not selected. */
  position: number;
  /** False when max actions are selected and this action is not one of them. */
  canInteract: boolean;
  /** Already a translation key, apply | translate in template. */
  tooltip: string;
  /** Already translated, do NOT apply | translate in template. */
  ariaLabel: string;
}

const ACTION_CONFIGS: ActionConfig[] = [
  {
    key: 'mount',
    label: 'actions.mount',
    icon: 'mount',
    getTooltip: remote => (remote.status.mount.active ? 'mount.mounted' : 'mount.toggleAction'),
    getActiveState: remote => remote.status.mount.active || false,
  },
  {
    key: 'sync',
    label: 'actions.sync',
    icon: 'sync',
    getTooltip: remote => (remote.status.sync.active ? 'sync.syncing' : 'sync.toggleSync'),
    getActiveState: remote => remote.status.sync.active || false,
  },
  {
    key: 'copy',
    label: 'actions.copy',
    icon: 'copy',
    getTooltip: remote => (remote.status.copy.active ? 'sync.copying' : 'sync.toggleCopy'),
    getActiveState: remote => remote.status.copy.active || false,
  },
  {
    key: 'move',
    label: 'actions.move',
    icon: 'move',
    getTooltip: remote => (remote.status.move.active ? 'sync.moving' : 'sync.toggleMove'),
    getActiveState: remote => remote.status.move.active || false,
  },
  {
    key: 'bisync',
    label: 'actions.bisync',
    icon: 'right-left',
    getTooltip: remote => (remote.status.bisync.active ? 'sync.bisyncActive' : 'sync.toggleBisync'),
    getActiveState: remote => remote.status.bisync.active || false,
  },
  {
    key: 'serve',
    label: 'actions.serve',
    icon: 'serve',
    getTooltip: remote => (remote.status.serve.active ? 'serve.serving' : 'serve.toggleAction'),
    getActiveState: remote => remote.status.serve.active || false,
  },
];

@Component({
  selector: 'app-general-detail',
  standalone: true,
  imports: [
    NgClass,
    TitleCasePipe,
    DatePipe,
    MatCardModule,
    MatIconModule,
    MatTooltipModule,
    MatButtonModule,
    SettingsPanelComponent,
    DiskUsagePanelComponent,
    JobsPanelComponent,
    TranslateModule,
  ],
  templateUrl: './general-detail.component.html',
  styleUrl: './general-detail.component.scss',
})
export class GeneralDetailComponent {
  // Protected so template can access it without exposing it as public API
  protected readonly iconService = inject(IconService);
  private readonly schedulerService = inject(SchedulerService);
  private readonly translate = inject(TranslateService);

  // Inputs
  readonly selectedRemote = input.required<Remote>();
  readonly jobs = input<JobInfo[]>([]);

  // Outputs
  readonly openRemoteConfigModal = output<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
  }>();
  readonly stopJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();
  readonly deleteJob = output<number>();
  readonly togglePrimaryAction = output<PrimaryActionType>();
  readonly retryDiskUsage = output<void>();

  // State
  private readonly allScheduledTasks = this.schedulerService.scheduledTasks;
  readonly currentTaskCardIndex = signal(0);

  // Static config — protected so template can read them
  protected readonly maxPrimaryActions = 3;
  protected readonly displayedColumns: string[] = [
    'type',
    'profile',
    'status',
    'progress',
    'startTime',
    'actions',
  ];

  // Static lookup tables — no reason to allocate per-instance
  private static readonly TASK_TYPE_ICONS: Record<string, string> = {
    sync: 'sync',
    copy: 'copy',
    move: 'move',
    bisync: 'right-left',
  };

  private static readonly TASK_STATUS_TOOLTIPS: Record<string, string> = {
    enabled: 'task.status.enabled',
    disabled: 'task.status.disabled',
    running: 'task.status.running',
    failed: 'task.status.failed',
    stopping: 'task.status.stopping',
  };

  private static readonly TOGGLE_TOOLTIPS: Record<string, string> = {
    enabled: 'task.toggle.disable',
    running: 'task.toggle.disable',
    disabled: 'task.toggle.enable',
    failed: 'task.toggle.enable',
    stopping: 'task.toggle.stopping',
  };

  private static readonly TOGGLE_ICONS: Record<string, string> = {
    enabled: 'pause',
    running: 'pause',
    disabled: 'play',
    failed: 'play',
    stopping: 'stop',
  };

  // Derivations
  readonly remoteScheduledTasks = computed(() => {
    const allTasks = this.allScheduledTasks();
    const remote = this.selectedRemote();
    if (!remote) return [];
    return allTasks.filter(task => task.args['remote_name'] === remote.name);
  });

  readonly hasScheduledTasks = computed(() => this.remoteScheduledTasks().length > 0);

  readonly currentTask = computed(
    () => this.remoteScheduledTasks()[this.currentTaskCardIndex()] ?? null
  );

  readonly canSelectMoreActions = computed(
    () => (this.selectedRemote().primaryActions?.length ?? 0) < this.maxPrimaryActions
  );

  readonly viewActionConfigs = computed<ActionViewModel[]>(() => {
    const remote = this.selectedRemote();
    const selectedActions = remote.primaryActions ?? [];
    const canSelectMore = selectedActions.length < this.maxPrimaryActions;

    return ACTION_CONFIGS.map(config => {
      const isSelected = selectedActions.includes(config.key);
      const position = isSelected ? selectedActions.indexOf(config.key) + 1 : 0;
      const label = this.translate.instant(config.label);

      return {
        key: config.key,
        label: config.label,
        icon: config.icon,
        isSelected,
        isActive: config.getActiveState(remote),
        position,
        canInteract: isSelected || canSelectMore,
        tooltip: config.getTooltip(remote),
        ariaLabel: isSelected
          ? this.translate.instant('dashboard.generalDetail.quickActionSelected', {
              label,
              position,
            })
          : this.translate.instant('dashboard.generalDetail.toggleQuickAction', { label }),
      };
    });
  });

  // Computed panel configurations
  readonly remoteConfigurationPanelConfig = computed<SettingsPanelConfig>(() => ({
    section: {
      key: 'remote-config',
      title: 'dashboard.generalDetail.remoteConfiguration',
      icon: 'wrench',
    },
    settings: this.selectedRemote().config,
    hasSettings: Object.keys(this.selectedRemote().config ?? {}).length > 0,
    buttonColor: 'primary',
    buttonLabel: 'dashboard.generalDetail.editConfiguration',
  }));

  readonly diskUsageConfig = computed<DiskUsage>(() => this.selectedRemote().status.diskUsage);

  readonly jobsPanelConfig = computed<JobsPanelConfig>(() => ({
    jobs: this.jobs(),
    displayedColumns: this.displayedColumns,
  }));

  constructor() {
    this.schedulerService
      .getScheduledTasks()
      .catch(err => console.error('Error loading scheduled tasks:', err));

    effect(() => {
      this.selectedRemote();
      this.currentTaskCardIndex.set(0);
    });
  }

  onToggleAction(actionKey: PrimaryActionType): void {
    const config = this.viewActionConfigs().find(c => c.key === actionKey);
    if (config?.canInteract) {
      this.togglePrimaryAction.emit(actionKey);
    }
  }

  onEditRemoteConfiguration(): void {
    this.openRemoteConfigModal.emit({
      editTarget: 'remote',
      existingConfig: this.selectedRemote().config as unknown as RemoteSettings,
    });
  }

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

  getTaskTypeIcon(taskType: string): string {
    return GeneralDetailComponent.TASK_TYPE_ICONS[taskType] ?? 'circle-info';
  }

  getTaskStatusTooltip(status: string): string {
    return GeneralDetailComponent.TASK_STATUS_TOOLTIPS[status] ?? '';
  }

  getToggleTooltip(status: string): string {
    return GeneralDetailComponent.TOGGLE_TOOLTIPS[status] ?? '';
  }

  getToggleIcon(status: string): string {
    return GeneralDetailComponent.TOGGLE_ICONS[status] ?? 'help';
  }
}

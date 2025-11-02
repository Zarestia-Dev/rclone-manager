import {
  Component,
  EventEmitter,
  Input,
  Output,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  inject,
  SimpleChanges,
  OnChanges,
} from '@angular/core';
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
  DiskUsageConfig,
  JobInfo,
  JobsPanelConfig,
  PrimaryActionType,
  Remote,
  RemoteSettings,
  SettingsPanelConfig,
} from '@app/types';
import {
  DiskUsagePanelComponent,
  JobsPanelComponent,
  SettingsPanelComponent,
} from '../../../../shared/detail-shared';
import { IconService } from 'src/app/shared/services/icon.service';

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
];

@Component({
  selector: 'app-general-detail',
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
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeneralDetailComponent implements OnChanges {
  cdr = inject(ChangeDetectorRef);
  readonly iconService = inject(IconService);

  @Input() selectedRemote!: Remote;
  @Input() jobs: JobInfo[] = [];
  @Input() restrictMode!: boolean;

  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
  }>();
  @Output() stopJob = new EventEmitter<{
    type: PrimaryActionType;
    remoteName: string;
  }>();
  @Output() deleteJob = new EventEmitter<number>();
  @Output() togglePrimaryAction = new EventEmitter<PrimaryActionType>();

  readonly displayedColumns: string[] = ['type', 'status', 'progress', 'startTime', 'actions'];
  readonly maxPrimaryActions = 3;
  readonly actionConfigs = ACTION_CONFIGS;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['selectedRemote']) {
      this.cdr.markForCheck();
    }
  }

  // Action status methods
  isActionSelected(actionKey: PrimaryActionType): boolean {
    return this.selectedRemote?.primaryActions?.includes(actionKey) || false;
  }

  isActionActive(actionKey: PrimaryActionType): boolean {
    const config = this.actionConfigs.find(c => c.key === actionKey);
    return config?.getActiveState(this.selectedRemote) || false;
  }

  getActionPosition(actionKey: PrimaryActionType): number {
    return (this.selectedRemote?.primaryActions?.indexOf(actionKey) ?? -1) + 1;
  }

  getActionTooltip(actionKey: PrimaryActionType): string {
    const config = this.actionConfigs.find(c => c.key === actionKey);
    return config?.getTooltip(this.selectedRemote) || '';
  }

  canSelectMoreActions(): boolean {
    return (this.selectedRemote?.primaryActions?.length || 0) < this.maxPrimaryActions;
  }

  onToggleAction(actionKey: PrimaryActionType): void {
    if (this.isActionSelected(actionKey) || this.canSelectMoreActions()) {
      this.togglePrimaryAction.emit(actionKey);
    }
  }

  // Configuration methods for shared components
  getRemoteConfigurationPanelConfig(): SettingsPanelConfig {
    return {
      section: {
        key: 'remote-config',
        title: 'Remote Configuration',
        icon: 'wrench',
      },
      settings: this.selectedRemote.remoteSpecs,
      hasSettings: Object.keys(this.selectedRemote.remoteSpecs).length > 0,
      restrictMode: this.restrictMode,
      buttonColor: 'primary',
      buttonLabel: 'Edit Configuration',
    };
  }

  getDiskUsageConfig(): DiskUsageConfig {
    return {
      mounted: this.selectedRemote.mountState?.mounted || false,
      diskUsage: this.selectedRemote.diskUsage,
    };
  }

  getJobsPanelConfig(): JobsPanelConfig {
    return {
      jobs: this.jobs,
      displayedColumns: this.displayedColumns,
    };
  }

  onEditRemoteConfiguration(): void {
    this.openRemoteConfigModal.emit({
      editTarget: 'remote',
      existingConfig: this.selectedRemote.remoteSpecs,
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

  // Track by function for better performance
  trackByActionKey(index: number, config: ActionConfig): PrimaryActionType {
    return config.key;
  }
}

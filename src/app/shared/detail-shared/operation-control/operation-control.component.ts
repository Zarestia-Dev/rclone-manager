import { Component, computed, input, output, inject, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { StatusBadgeComponent } from '../status-badge/status-badge.component';
import { PathDisplayComponent } from '../path-display/path-display.component';
import {
  OperationControlConfig,
  PrimaryActionType,
  StatusBadgeConfig,
  LocalDiskUsage,
} from '@app/types';
import { FormatFileSizePipe } from '@app/pipes';
import { SystemInfoService } from '@app/services';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-operation-control',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatExpansionModule,
    MatProgressBarModule,
    StatusBadgeComponent,
    PathDisplayComponent,
    TranslateModule,
    FormatFileSizePipe,
  ],
  template: `
    <mat-expansion-panel
      class="operation-panel"
      (opened)="isExpanded = true"
      (closed)="isExpanded = false"
    >
      <mat-expansion-panel-header>
        <mat-panel-title>
          <mat-icon [svgIcon]="operationIcon()" class="panel-icon"></mat-icon>
          <div class="profile-info">
            <span class="profile-name">{{ config().profileName || 'default' }}</span>
            <app-status-badge [config]="statusBadgeConfig()"></app-status-badge>
          </div>
        </mat-panel-title>

        <mat-panel-description>
          <div class="quick-action-wrapper" [class.hidden]="isExpanded">
            <button
              mat-icon-button
              class="quick-action"
              [ngClass]="buttonClass()"
              (click)="handleQuickAction($event)"
              [disabled]="config().isLoading"
              [matTooltip]="(config().isActive ? 'actions.stop' : 'actions.start') | translate"
            >
              @if (config().isLoading) {
                <mat-spinner diameter="24"></mat-spinner>
              } @else {
                <mat-icon
                  [svgIcon]="config().isActive ? config().secondaryIcon : config().primaryIcon"
                ></mat-icon>
              }
            </button>
          </div>
        </mat-panel-description>
      </mat-expansion-panel-header>

      <div class="panel-content">
        <app-path-display
          [config]="config().pathConfig"
          (openPath)="openPath.emit($event)"
        ></app-path-display>

        @if (diskUsage(); as usage) {
          <div class="disk-usage-info">
            <div class="usage-stats">
              <span class="stat-label">{{ 'detailShared.diskUsage.title' | translate }}</span>
              <span class="stat-value">
                {{ usage.used | formatFileSize }} / {{ usage.total | formatFileSize }}
              </span>
            </div>
            <mat-progress-bar
              mode="determinate"
              [value]="(usage.used / usage.total) * 100"
              class="usage-bar"
              [color]="getUsageColor(usage.used / usage.total)"
            ></mat-progress-bar>
            <span class="usage-free">{{
              'detailShared.diskUsage.free' | translate: { value: (usage.free | formatFileSize) }
            }}</span>
          </div>
        }

        <div class="panel-actions">
          <button
            mat-flat-button
            [ngClass]="buttonClass()"
            (click)="
              config().isActive
                ? stopJob.emit(config().operationType)
                : startJob.emit(config().operationType)
            "
            [disabled]="config().isLoading"
            class="full-action-button"
          >
            @if (config().isLoading) {
              <mat-spinner diameter="24"></mat-spinner>
            } @else {
              <mat-icon
                [svgIcon]="config().isActive ? config().secondaryIcon : config().primaryIcon"
              ></mat-icon>
            }
            <span>{{
              (config().isActive ? config().secondaryButtonLabel : config().primaryButtonLabel)
                | translate
            }}</span>
          </button>
        </div>
      </div>
    </mat-expansion-panel>
  `,
  styles: [
    `
      .quick-action-wrapper {
        display: flex;
        align-items: center;
        overflow: hidden;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        max-width: 40px;
        opacity: 1;
        transform: translateX(0);

        &.hidden {
          max-width: 0;
          opacity: 0;
          transform: translateX(20px);
        }
      }

      .panel-actions {
        margin-top: var(--space-md);

        .full-action-button {
          width: 100%;
        }
      }

      .profile-info {
        display: flex;
        align-items: center;
        gap: var(--space-sm);
      }

      .disk-usage-info {
        margin-top: var(--space-md);
        padding: var(--space-sm);
        background: var(--surface-variant);
        border-radius: var(--radius-sm);
        display: flex;
        flex-direction: column;
        gap: 4px;

        .usage-stats {
          display: flex;
          justify-content: space-between;
          font-size: var(--body-sm);
          color: var(--text-secondary);
        }

        .usage-bar {
          height: 6px;
          border-radius: 3px;
        }

        .usage-free {
          font-size: var(--body-xs);
          color: var(--text-tertiary);
          text-align: right;
        }
      }
    `,
  ],
})
export class OperationControlComponent {
  config = input.required<OperationControlConfig>();
  startJob = output<PrimaryActionType>();
  stopJob = output<PrimaryActionType>();
  openPath = output<string>();

  private readonly systemInfo = inject(SystemInfoService);

  // Track expansion state for animation
  isExpanded = false;

  diskUsage = signal<LocalDiskUsage | null>(null);

  constructor() {
    effect(async () => {
      const config = this.config();
      // Only fetch for active mount operations with a valid destination
      if (
        config.operationType === 'mount' &&
        config.isActive &&
        config.pathConfig.destination &&
        !config.pathConfig.destination.includes('Not configured')
      ) {
        try {
          // Poll every 5 seconds while active
          const usage = await this.systemInfo.getLocalDiskUsage(config.pathConfig.destination);
          this.diskUsage.set(usage);
        } catch (error) {
          console.error('Failed to fetch disk usage:', error);
          this.diskUsage.set(null);
        }
      } else {
        this.diskUsage.set(null);
      }
    });

    // Setup polling interval
    effect(onCleanup => {
      const config = this.config();
      if (
        config.operationType === 'mount' &&
        config.isActive &&
        config.pathConfig.destination &&
        !config.pathConfig.destination.includes('Not configured')
      ) {
        const interval = setInterval(async () => {
          try {
            const usage = await this.systemInfo.getLocalDiskUsage(config.pathConfig.destination);
            this.diskUsage.set(usage);
          } catch {
            // Silently fail on poll
          }
        }, 5000);

        onCleanup(() => clearInterval(interval));
      }
    });
  }

  handleQuickAction(event: Event): void {
    event.preventDefault();
    event.stopPropagation();

    if (this.config().isActive) {
      this.stopJob.emit(this.config().operationType);
    } else {
      this.startJob.emit(this.config().operationType);
    }
  }

  getUsageColor(ratio: number): string {
    if (ratio > 0.9) return 'warn';
    if (ratio > 0.7) return 'accent';
    return 'primary';
  }

  // Operation icon configuration
  private readonly OPERATION_ICONS: Record<PrimaryActionType, string> = {
    mount: 'mount',
    sync: 'refresh',
    bisync: 'right-left',
    move: 'move',
    copy: 'copy',
    serve: 'serve',
  };

  readonly operationIcon = computed(
    () => this.OPERATION_ICONS[this.config().operationType] || 'refresh'
  );

  readonly statusBadgeConfig = computed((): StatusBadgeConfig => {
    const config = this.config();
    // Define status labels for each operation type
    const statusLabels: Record<PrimaryActionType, { active: string; inactive: string }> = {
      mount: { active: 'detailShared.status.mounted', inactive: 'detailShared.status.notMounted' },
      sync: { active: 'detailShared.status.syncing', inactive: 'detailShared.status.stopped' },
      bisync: { active: 'detailShared.status.bisyncing', inactive: 'detailShared.status.stopped' },
      move: { active: 'detailShared.status.moving', inactive: 'detailShared.status.stopped' },
      copy: { active: 'detailShared.status.copying', inactive: 'detailShared.status.stopped' },
      serve: { active: 'detailShared.status.serving', inactive: 'detailShared.status.stopped' },
    };

    // Determine the current state
    let state: 'active' | 'inactive' | 'error';
    if (config.isError) {
      state = 'error';
    } else if (config.isActive) {
      state = 'active';
    } else {
      state = 'inactive';
    }

    // Resolve the badge class per operation and state
    let resolvedBadgeClass = '';
    if (state === 'error') {
      resolvedBadgeClass = 'error';
    } else if (state === 'active') {
      // Active operation: use mounted for mount, otherwise active-<op>
      if (config.operationType === 'mount') {
        resolvedBadgeClass = 'mounted';
      } else {
        resolvedBadgeClass = `active-${config.operationType}`;
      }
    } else {
      // Inactive: use unmounted for mount, otherwise generic inactive
      if (config.operationType === 'mount') {
        resolvedBadgeClass = 'unmounted';
      } else {
        resolvedBadgeClass = 'inactive';
      }
    }

    return {
      isActive: config.isActive,
      isError: config.isError,
      isLoading: config.isLoading,
      activeLabel: statusLabels[config.operationType].active,
      inactiveLabel: statusLabels[config.operationType].inactive,
      errorLabel: 'Error',
      badgeClass: resolvedBadgeClass,
    };
  });

  readonly buttonClass = computed(() => {
    const config = this.config();
    // When active, always use the warn class to emphasize stopping an active op.
    if (config?.isActive) return 'warn';
    return config?.cssClass || '';
  });
}

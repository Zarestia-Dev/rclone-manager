import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  inject,
  signal,
  effect,
} from '@angular/core';
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
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
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
      (opened)="isExpanded.set(true)"
      (closed)="isExpanded.set(false)"
    >
      <mat-expansion-panel-header>
        <mat-panel-title>
          <mat-icon [svgIcon]="operationIcon()" style="color: var(--op-color)"></mat-icon>
          <div class="profile-info">
            <span class="profile-name">{{ config().profileName || 'default' }}</span>
            <app-status-badge [config]="statusBadgeConfig()"></app-status-badge>
          </div>
        </mat-panel-title>

        <mat-panel-description>
          <div class="quick-action-wrapper" [class.hidden]="isExpanded()">
            <button
              mat-icon-button
              class="quick-action"
              [class]="buttonClass()"
              (click)="handleQuickAction($event)"
              [disabled]="config().isLoading"
              [matTooltip]="
                (config().isActive && config().operationType === 'mount'
                  ? 'actions.unmount'
                  : config().isActive
                    ? 'actions.stop'
                    : 'actions.start'
                ) | translate
              "
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
            [class]="buttonClass()"
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
  readonly config = input.required<OperationControlConfig>();
  readonly startJob = output<PrimaryActionType>();
  readonly stopJob = output<PrimaryActionType>();
  readonly openPath = output<string>();

  private readonly systemInfo = inject(SystemInfoService);

  readonly isExpanded = signal(false);
  readonly diskUsage = signal<LocalDiskUsage | null>(null);

  private readonly mountDestination = computed(() => this.config().pathConfig.destination ?? '');

  private readonly shouldPollDiskUsage = computed(() => {
    const { operationType, isActive, pathConfig } = this.config();
    const destination = pathConfig.destination ?? '';
    return (
      operationType === 'mount' &&
      isActive &&
      !!destination &&
      !destination.includes('Not configured')
    );
  });

  constructor() {
    effect(onCleanup => {
      if (!this.shouldPollDiskUsage()) {
        this.diskUsage.set(null);
        return;
      }

      const destination = this.mountDestination();
      const fetchDiskUsage = async (): Promise<void> => {
        try {
          this.diskUsage.set(await this.systemInfo.getLocalDiskUsage(destination));
        } catch {
          this.diskUsage.set(null);
        }
      };

      void fetchDiskUsage();
      const interval = setInterval(() => void fetchDiskUsage(), 5000);
      onCleanup(() => clearInterval(interval));
    });
  }

  handleQuickAction(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    const { isActive, operationType } = this.config();
    if (isActive) {
      this.stopJob.emit(operationType);
    } else {
      this.startJob.emit(operationType);
    }
  }

  getUsageColor(ratio: number): string {
    if (ratio > 0.9) return 'warn';
    if (ratio > 0.7) return 'accent';
    return 'primary';
  }

  private static readonly OPERATION_ICONS: Record<PrimaryActionType, string> = {
    mount: 'mount',
    sync: 'refresh',
    bisync: 'right-left',
    move: 'move',
    copy: 'copy',
    serve: 'serve',
  };

  readonly operationIcon = computed(
    () => OperationControlComponent.OPERATION_ICONS[this.config().operationType] ?? 'refresh'
  );

  readonly statusBadgeConfig = computed((): StatusBadgeConfig => {
    const config = this.config();

    const statusLabels: Record<PrimaryActionType, { active: string; inactive: string }> = {
      mount: { active: 'detailShared.status.mounted', inactive: 'detailShared.status.notMounted' },
      sync: { active: 'detailShared.status.syncing', inactive: 'detailShared.status.stopped' },
      bisync: { active: 'detailShared.status.bisyncing', inactive: 'detailShared.status.stopped' },
      move: { active: 'detailShared.status.moving', inactive: 'detailShared.status.stopped' },
      copy: { active: 'detailShared.status.copying', inactive: 'detailShared.status.stopped' },
      serve: { active: 'detailShared.status.serving', inactive: 'detailShared.status.stopped' },
    };

    const state = config.isError ? 'error' : config.isActive ? 'active' : 'inactive';

    let resolvedBadgeClass: string;
    if (state === 'error') {
      resolvedBadgeClass = 'error';
    } else if (state === 'active') {
      resolvedBadgeClass =
        config.operationType === 'mount' ? 'mounted' : `active-${config.operationType}`;
    } else {
      resolvedBadgeClass = config.operationType === 'mount' ? 'unmounted' : 'inactive';
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
    const { isActive, cssClass } = this.config();
    return isActive ? 'warn' : (cssClass ?? '');
  });
}

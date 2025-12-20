import { Component, computed, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { StatusBadgeComponent } from '../status-badge/status-badge.component';
import { PathDisplayComponent } from '../path-display/path-display.component';
import { OperationControlConfig, PrimaryActionType, StatusBadgeConfig } from '@app/types';

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
    StatusBadgeComponent,
    PathDisplayComponent,
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
          <span class="panel-title-text">{{ config().profileName || 'default' }}</span>
        </mat-panel-title>

        <mat-panel-description>
          <app-status-badge [config]="statusBadgeConfig()"></app-status-badge>

          <div class="quick-action-wrapper" [class.hidden]="isExpanded">
            @if (config().isLoading) {
              <mat-spinner diameter="20" class="panel-spinner"></mat-spinner>
            } @else {
              <button
                mat-icon-button
                class="quick-action"
                [ngClass]="buttonClass()"
                (click)="handleQuickAction($event)"
                [matTooltip]="config().isActive ? 'Stop' : 'Start'"
              >
                <mat-icon
                  [svgIcon]="config().isActive ? config().secondaryIcon : config().primaryIcon"
                ></mat-icon>
              </button>
            }
          </div>
        </mat-panel-description>
      </mat-expansion-panel-header>

      <div class="panel-content">
        <app-path-display
          [config]="config().pathConfig"
          (openPath)="openPath.emit($event)"
        ></app-path-display>

        <div class="panel-actions">
          <button
            matButton="filled"
            (click)="
              config().isActive
                ? stopJob.emit(config().operationType)
                : startJob.emit(config().operationType)
            "
            [disabled]="config().isLoading"
            [ngClass]="buttonClass()"
            class="full-action-button"
          >
            @if (config().isLoading) {
              <mat-spinner diameter="20"></mat-spinner>
            } @else {
              <mat-icon
                [svgIcon]="config().isActive ? config().secondaryIcon : config().primaryIcon"
              ></mat-icon>
            }
            <span>{{
              config().isActive ? config().secondaryButtonLabel : config().primaryButtonLabel
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
    `,
  ],
})
export class OperationControlComponent {
  config = input.required<OperationControlConfig>();
  startJob = output<PrimaryActionType>();
  stopJob = output<PrimaryActionType>();
  openPath = output<string>();

  // Track expansion state for animation
  isExpanded = false;

  handleQuickAction(event: Event): void {
    event.preventDefault();
    event.stopPropagation();

    if (this.config().isActive) {
      this.stopJob.emit(this.config().operationType);
    } else {
      this.startJob.emit(this.config().operationType);
    }
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
      mount: { active: 'Mounted', inactive: 'Not Mounted' },
      sync: { active: 'Syncing', inactive: 'Stopped' },
      bisync: { active: 'BiSyncing', inactive: 'Stopped' },
      move: { active: 'Moving', inactive: 'Stopped' },
      copy: { active: 'Copying', inactive: 'Stopped' },
      serve: { active: 'Serving', inactive: 'Stopped' },
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

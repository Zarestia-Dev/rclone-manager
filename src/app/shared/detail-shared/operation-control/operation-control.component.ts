import { Component, computed, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
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
    MatSlideToggleModule,
    StatusBadgeComponent,
    PathDisplayComponent,
  ],
  styleUrls: ['./operation-control.component.scss'],
  template: `
    <mat-card class="detail-panel operation-control-panel" [class.active]="config().isActive">
      <mat-card-header class="panel-header" [ngClass]="config().operationType">
        <mat-card-title class="panel-title-content">
          <mat-icon [svgIcon]="operationIcon()" class="panel-icon"></mat-icon>
          <span>{{ config().operationType | titlecase }} Control</span>
        </mat-card-title>
      </mat-card-header>

      <mat-card-content class="panel-content">
        <app-path-display [config]="config().pathConfig" (openPath)="openPath.emit($event)">
        </app-path-display>
      </mat-card-content>

      <mat-card-actions class="panel-actions">
        <app-status-badge [config]="statusBadgeConfig()"></app-status-badge>
        <div class="operation-controls">
          <button
            matButton="filled"
            (click)="
              config().isActive
                ? stopJob.emit(config().operationType)
                : startJob.emit(config().operationType)
            "
            [disabled]="config().isLoading"
            [ngClass]="buttonClass()"
            class="operation-toggle-button"
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
      </mat-card-actions>
    </mat-card>
  `,
})
export class OperationControlComponent {
  config = input.required<OperationControlConfig>();
  startJob = output<PrimaryActionType>();
  stopJob = output<PrimaryActionType>();
  openPath = output<string>();

  readonly operationIcon = computed(() => {
    // Use subOperationType for sync operations
    switch (this.config().operationType) {
      case 'mount':
        return 'mount';
      case 'sync':
        return 'refresh';
      case 'bisync':
        return 'right-left';
      case 'move':
        return 'move';
      case 'copy':
        return 'copy';
      default:
        return 'refresh'; // Default icon
    }
  });

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

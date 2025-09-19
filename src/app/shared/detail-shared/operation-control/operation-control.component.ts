import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { StatusBadgeComponent } from '../status-badge/status-badge.component';
import { PathDisplayComponent } from '../path-display/path-display.component';
import { OperationControlConfig, PrimaryActionType, StatusBadgeConfig } from '../../types';

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
    <mat-card
      class="detail-panel operation-control-panel"
      [class.active]="config.isActive"
      [ngClass]="config.operationClass"
    >
      <mat-card-header class="panel-header">
        <mat-card-title class="panel-title-content">
          <mat-icon [svgIcon]="getOperationIcon()" class="panel-icon"></mat-icon>
          <span>{{ config.operationType | titlecase }} Control</span>
        </mat-card-title>
      </mat-card-header>

      <mat-card-content class="panel-content">
        <app-path-display [config]="config.pathConfig" (openPath)="onOpenPath($event)">
        </app-path-display>
      </mat-card-content>

      <mat-card-actions class="panel-actions">
        <app-status-badge [config]="getStatusBadgeConfig()"></app-status-badge>
        <div class="operation-controls">
          <button
            matButton="filled"
            (click)="
              config.isActive
                ? stopJob.emit(config.operationType)
                : startJob.emit(config.operationType)
            "
            [disabled]="config.isLoading"
            class="operation-toggle-button"
          >
            @if (config.isLoading) {
              <mat-spinner diameter="20"></mat-spinner>
            } @else {
              <mat-icon
                [svgIcon]="config.isActive ? config.secondaryIcon : config.primaryIcon"
              ></mat-icon>
            }
            <span>{{
              config.isActive ? config.secondaryButtonLabel : config.primaryButtonLabel
            }}</span>
          </button>
        </div>
      </mat-card-actions>
    </mat-card>
  `,
})
export class OperationControlComponent {
  @Input() config!: OperationControlConfig;
  @Output() startJob = new EventEmitter<PrimaryActionType>();
  @Output() stopJob = new EventEmitter<PrimaryActionType>();
  @Output() openPath = new EventEmitter<string>();

  getOperationIcon(): string {
    // Use subOperationType for sync operations
    switch (this.config.operationType) {
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
  }

  getStatusBadgeConfig(): StatusBadgeConfig {
    // Define status labels for each operation type
    const statusLabels: Record<PrimaryActionType, { active: string; inactive: string }> = {
      mount: { active: 'Mounted', inactive: 'Not Mounted' },
      sync: { active: 'Syncing', inactive: 'Stopped' },
      bisync: { active: 'BiSyncing', inactive: 'Stopped' },
      move: { active: 'Moving', inactive: 'Stopped' },
      copy: { active: 'Copying', inactive: 'Stopped' },
    };

    // Define badge classes for each state
    const badgeClasses = {
      active: this.config.operationType === 'mount' ? 'mounted' : '',
      inactive: this.config.operationType === 'mount' ? 'unmounted' : 'inactive',
      error: 'error',
    };

    // Determine the current state
    let state: 'active' | 'inactive' | 'error';
    if (this.config.isError) {
      state = 'error';
    } else if (this.config.isActive) {
      state = 'active';
    } else {
      state = 'inactive';
    }

    return {
      isActive: this.config.isActive,
      isError: this.config.isError,
      isLoading: this.config.isLoading,
      activeLabel: statusLabels[this.config.operationType].active,
      inactiveLabel: statusLabels[this.config.operationType].inactive,
      errorLabel: 'Error',
      badgeClass: badgeClasses[state],
    };
  }

  onOpenPath(path: string): void {
    this.openPath.emit(path);
  }
}

import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ThemePalette } from '@angular/material/core';
import { StatusBadgeComponent, StatusBadgeConfig } from '../status-badge/status-badge.component';
import { PathDisplayComponent, PathDisplayConfig } from '../path-display/path-display.component';

export type SyncOperationType = 'sync' | 'bisync' | 'move' | 'copy';
export type MainOperationType = 'sync' | 'mount';

export interface OperationControlConfig {
  operationType: 'sync' | 'mount';
  isActive: boolean;
  isError?: boolean;
  isLoading: boolean;
  subOperationType?: SyncOperationType;
  operationColor: ThemePalette;
  operationClass: string;
  pathConfig: PathDisplayConfig;
  primaryButtonLabel: string;
  primaryIcon: string;
  secondaryButtonLabel: string;
  secondaryIcon: string;
  actionInProgress?: string;
  operationDescription?: string;
}

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
          <span>{{ config.subOperationType | titlecase }} Control</span>
        </mat-card-title>
      </mat-card-header>

      <mat-card-content class="panel-content">
        <app-path-display [config]="config.pathConfig" (openPath)="onOpenPath($event)">
        </app-path-display>

        <!-- Resync Toggle for Bisync -->
        <!-- @if (shouldShowResyncToggle()) {
          <div class="resync-control">
            <mat-slide-toggle
              [checked]="false"
              [disabled]="config.isActive || config.isLoading"
              (change)="onResyncToggle($event.checked)"
            >
              <span class="resync-label">
                <mat-icon svgIcon="refresh" class="resync-icon"></mat-icon>
                Force Resync
              </span>
            </mat-slide-toggle>
            <div class="resync-description">
              Performs a full resynchronization, rebuilding the sync database
            </div>
          </div>
        } -->
      </mat-card-content>

      <mat-card-actions class="panel-actions">
        <app-status-badge [config]="getStatusBadgeConfig()"></app-status-badge>
        <div class="operation-controls">
          <button
            mat-raised-button
            [color]="config.isActive ? 'warn' : config.operationColor"
            (click)="config.isActive ? onSecondaryAction() : onPrimaryAction()"
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
  @Output() primaryAction = new EventEmitter<void>();
  @Output() secondaryAction = new EventEmitter<void>();
  @Output() openPath = new EventEmitter<string>();
  // @Output() data = new EventEmitter<{ resync: boolean; dryRun: boolean }>();

  // resync = false;
  // dryRun = false;

  getOperationIcon(): string {
    // Use subOperationType for sync operations
    if (this.config.operationType === 'sync' && this.config.subOperationType) {
      switch (this.config.subOperationType) {
        case 'sync':
          return 'refresh';
        case 'bisync':
          return 'right-left';
        case 'move':
          return 'move';
        case 'copy':
          return 'copy';
        default:
          return 'sync';
      }
    }
    switch (this.config.operationType) {
      case 'mount':
        return 'mount';
      default:
        return 'play';
    }
  }

  getStatusBadgeConfig(): StatusBadgeConfig {
    const isOperationType = this.config.operationType !== 'mount';
    let badgeClass = '';
    if (this.config.isActive && !this.config.isError) {
      if (this.config.operationType === 'sync' && this.config.subOperationType) {
        badgeClass = `active-${this.config.subOperationType}`;
      } else {
        switch (this.config.operationType) {
          case 'mount':
            badgeClass = 'mounted';
            break;
          default:
            badgeClass = '';
        }
      }
    } else if (!this.config.isActive && !this.config.isError) {
      badgeClass = isOperationType ? 'inactive' : 'unmounted';
    } else if (this.config.isError) {
      badgeClass = 'error';
    }

    let activeLabel = 'Active';
    if (this.config.operationType === 'sync' && this.config.subOperationType) {
      switch (this.config.subOperationType) {
        case 'sync':
          activeLabel = 'Syncing';
          break;
        case 'bisync':
          activeLabel = 'BiSyncing';
          break;
        case 'move':
          activeLabel = 'Moving';
          break;
        case 'copy':
          activeLabel = 'Copying';
          break;
        default:
          activeLabel = 'Syncing';
      }
    } else if (this.config.operationType === 'mount') {
      activeLabel = 'Mounted';
    }

    return {
      isActive: this.config.isActive,
      isError: this.config.isError,
      isLoading: this.config.isLoading,
      activeLabel,
      inactiveLabel: isOperationType ? 'Stopped' : 'Not Mounted',
      errorLabel: 'Error',
      badgeClass,
    };
  }

  onPrimaryAction(): void {
    this.primaryAction.emit();
  }

  onSecondaryAction(): void {
    this.secondaryAction.emit();
  }

  onOpenPath(path: string): void {
    this.openPath.emit(path);
  }

  shouldShowResyncToggle(): boolean {
    return this.config.subOperationType === 'bisync';
  }

  // onResyncToggle(checked: boolean): void {
  //   console.log('Re-sync toggle changed:', checked);
  //   this.resync = checked;
  // }
}

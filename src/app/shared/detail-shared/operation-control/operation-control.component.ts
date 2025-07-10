import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ThemePalette } from '@angular/material/core';
import { StatusBadgeComponent, StatusBadgeConfig } from '../status-badge/status-badge.component';
import { PathDisplayComponent, PathDisplayConfig } from '../path-display/path-display.component';

export interface OperationControlConfig {
  operationType: 'sync' | 'copy' | 'mount';
  isActive: boolean;
  isError?: boolean;
  isLoading: boolean;
  operationColor: ThemePalette;
  operationClass: string;
  pathConfig: PathDisplayConfig;
  primaryButtonLabel: string;
  secondaryButtonLabel: string;
  actionInProgress?: string;
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
            mat-raised-button
            [color]="config.isActive ? 'warn' : config.operationColor"
            (click)="config.isActive ? onSecondaryAction() : onPrimaryAction()"
            [disabled]="config.isLoading"
            class="operation-toggle-button"
          >
            @if (config.isLoading) {
              <mat-spinner diameter="20"></mat-spinner>
            } @else {
              <mat-icon [svgIcon]="config.isActive ? 'stop' : 'play'"></mat-icon>
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

  getOperationIcon(): string {
    switch (this.config.operationType) {
      case 'sync':
        return 'sync';
      case 'copy':
        return 'copy';
      case 'mount':
        return 'mount';
      default:
        return 'play';
    }
  }

  getStatusBadgeConfig(): StatusBadgeConfig {
    const isOperationType = this.config.operationType !== 'mount';

    return {
      isActive: this.config.isActive,
      isError: this.config.isError,
      isLoading: this.config.isLoading,
      activeLabel: isOperationType
        ? this.config.operationType === 'sync'
          ? 'Syncing'
          : 'Copying'
        : 'Mounted',
      inactiveLabel: isOperationType ? 'Stopped' : 'Not Mounted',
      errorLabel: 'Error',
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
}

import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSortModule } from '@angular/material/sort';
import { MatChipsModule } from '@angular/material/chips';
import { ActiveTransfersTableComponent } from './active-transfers-table.component';
import { CompletedTransfersTableComponent } from './completed-transfers-table.component';
import { TransferFile } from '../../../shared/components/types';

export interface CompletedTransfer {
  name: string;
  size: number;
  bytes: number;
  checked: boolean;
  error: string;
  jobid: number;
  startedAt?: string;  // ISO timestamp from API
  completedAt?: string; // ISO timestamp from API
  srcFs?: string;      // Source filesystem
  dstFs?: string;      // Destination filesystem
  group?: string;      // Job group
  status: 'completed' | 'checked' | 'failed' | 'partial';
}

export interface TransferActivityPanelConfig {
  activeTransfers: TransferFile[];
  completedTransfers: CompletedTransfer[];
  operationClass: string;
  operationColor: string;
  remoteName: string;
  showHistory: boolean;
}

@Component({
  selector: 'app-transfer-activity-panel',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatTableModule,
    MatButtonModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatTabsModule,
    MatSortModule,
    MatChipsModule,
    ActiveTransfersTableComponent,
    CompletedTransfersTableComponent,
  ],
  template: `
    <mat-card class="detail-panel transfer-activity-panel" [ngClass]="config.operationClass">
      <mat-card-header class="panel-header">
        <mat-card-title class="panel-title-content">
          <mat-icon svgIcon="download" class="panel-icon"></mat-icon>
          <span>Transfer Activity</span>
          <div class="transfer-summary">
            <mat-chip class="summary-chip active" [color]="config.operationColor">
              <span class="chip-label">Active:</span>
              <span class="chip-value">{{ config.activeTransfers.length }}</span>
            </mat-chip>
            @if (config.showHistory) {
              <mat-chip class="summary-chip completed">
                <span class="chip-label">Recent:</span>
                <span class="chip-value">{{ config.completedTransfers.length }}</span>
              </mat-chip>
            }
          </div>
        </mat-card-title>
      </mat-card-header>
      
      <mat-card-content class="panel-content">
        @if (config.showHistory && config.completedTransfers.length > 0) {
          <mat-tab-group class="transfer-tabs" animationDuration="200ms">
            <!-- Active Transfers Tab -->
            <mat-tab>
              <ng-template mat-tab-label>
                <span>Active ({{ config.activeTransfers.length }})</span>
              </ng-template>
              <div class="tab-content">
                <app-active-transfers-table [transfers]="config.activeTransfers" [operationClass]="config.operationClass"></app-active-transfers-table>
              </div>
            </mat-tab>
            
            <!-- Completed Transfers Tab -->
            <mat-tab>
              <ng-template mat-tab-label>
                <span>Recent ({{ config.completedTransfers.length }})</span>
              </ng-template>
              <div class="tab-content">
                <app-completed-transfers-table [transfers]="config.completedTransfers" [operationClass]="config.operationClass"></app-completed-transfers-table>
              </div>
            </mat-tab>
          </mat-tab-group>
        } @else {
          <!-- Show only active transfers when no history -->
          <app-active-transfers-table [transfers]="config.activeTransfers" [operationClass]="config.operationClass"></app-active-transfers-table>
        }
      </mat-card-content>
    </mat-card>
  `,
  styleUrls: ['./transfer-activity-panel.component.scss']
})
export class TransferActivityPanelComponent implements OnInit, OnDestroy {
  @Input() config!: TransferActivityPanelConfig;
  @Output() refreshTransfers = new EventEmitter<void>();

  ngOnInit(): void {
    // Setup any initialization logic
  }

  ngOnDestroy(): void {
    // Cleanup logic
  }
}

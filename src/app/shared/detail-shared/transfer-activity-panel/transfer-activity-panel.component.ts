import {
  Component,
  Input,
  Output,
  EventEmitter,
  ChangeDetectionStrategy,
  OnInit,
  ChangeDetectorRef,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSortModule } from '@angular/material/sort';
import { MatChipsModule } from '@angular/material/chips';
import { ActiveTransfersTableComponent } from './active-transfers-table.component';
import { CompletedTransfersTableComponent } from './completed-transfers-table.component';
import { CompletedTransfer, TransferActivityPanelConfig, TransferFile } from '../../types';
import { distinctUntilChanged, Subject } from 'rxjs';

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
    MatTabsModule,
    MatSortModule,
    MatChipsModule,
    ActiveTransfersTableComponent,
    CompletedTransfersTableComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card class="detail-panel transfer-activity-panel" [ngClass]="config.operationClass">
      <mat-card-header class="panel-header">
        <mat-card-title class="panel-title-content">
          <mat-icon svgIcon="download" class="panel-icon"></mat-icon>
          <span>Transfer Activity</span>
          <div class="transfer-summary">
            <mat-chip [class]="'summary-chip active' + ' ' + config.operationColor">
              <span class="chip-label">Active:</span>
              <span class="chip-value">{{ config.activeTransfers.length }}</span>
            </mat-chip>
            @if (config.showHistory) {
              <mat-chip [class]="'summary-chip completed' + ' ' + config.operationColor">
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
                <app-active-transfers-table
                  [transfers]="config.activeTransfers"
                  [operationClass]="config.operationClass"
                ></app-active-transfers-table>
              </div>
            </mat-tab>

            <!-- Completed Transfers Tab -->
            <mat-tab>
              <ng-template mat-tab-label>
                <span>Recent ({{ config.completedTransfers.length }})</span>
              </ng-template>
              <div class="tab-content">
                <app-completed-transfers-table
                  [transfers]="config.completedTransfers"
                  [operationClass]="config.operationClass"
                  [trackBy]="trackByCompletedTransfer"
                ></app-completed-transfers-table>
              </div>
            </mat-tab>
          </mat-tab-group>
        } @else {
          <!-- Show only active transfers when no history -->
          <app-active-transfers-table
            [transfers]="config.activeTransfers"
            [operationClass]="config.operationClass"
            [trackBy]="trackByActiveTransfer"
          ></app-active-transfers-table>
        }
      </mat-card-content>
    </mat-card>
  `,
  styleUrls: ['./transfer-activity-panel.component.scss'],
})
export class TransferActivityPanelComponent implements OnInit {
  @Input() config!: TransferActivityPanelConfig;
  @Output() refreshTransfers = new EventEmitter<void>();

  private update$ = new Subject<void>();

  private cdr = inject(ChangeDetectorRef);

  trackByActiveTransfer(index: number, transfer: TransferFile): string {
    return transfer.name + transfer.percentage;
  }

  trackByCompletedTransfer(index: number, transfer: CompletedTransfer): string {
    return transfer.name + transfer.completedAt;
  }

  ngOnInit(): void {
    this.update$.pipe(distinctUntilChanged()).subscribe(() => {
      // Force change detection if needed
      this.cdr.markForCheck();
    });
  }
}

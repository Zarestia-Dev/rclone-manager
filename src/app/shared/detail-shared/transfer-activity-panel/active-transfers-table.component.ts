import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TransferFile } from '../../../shared/components/types';
import { ScrollingModule } from '@angular/cdk/scrolling';

@Component({
  selector: 'app-active-transfers-table',
  standalone: true,
  imports: [
    CommonModule,
    MatTableModule,
    MatProgressBarModule,
    MatIconModule,
    MatTooltipModule,
    ScrollingModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="transfers-table-container">
      @if (transfers.length > 0) {
        <cdk-virtual-scroll-viewport itemSize="50" class="transfers-viewport">
          <table mat-table [dataSource]="transfers" class="transfers-table">
            <!-- Name Column -->
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef>File</th>
              <td mat-cell *matCellDef="let transfer" class="name-cell">
                <div class="file-info">
                  <mat-icon svgIcon="file" class="file-icon" matTooltip="{{ transfer.name }}">
                  </mat-icon>
                  <span class="file-name" [title]="transfer.name">{{
                    getFileName(transfer.name)
                  }}</span>
                  @if (transfer.isError) {
                    <mat-icon
                      svgIcon="circle-exclamation"
                      class="error-icon"
                      matTooltip="Transfer error"
                      color="warn"
                    ></mat-icon>
                  }
                  @if (transfer.isCompleted) {
                    <mat-icon
                      svgIcon="circle-check"
                      class="success-icon"
                      matTooltip="Transfer completed"
                      color="primary"
                    ></mat-icon>
                  }
                </div>
              </td>
            </ng-container>

            <!-- Progress Column -->
            <ng-container matColumnDef="progress">
              <th mat-header-cell *matHeaderCellDef>Progress</th>
              <td mat-cell *matCellDef="let transfer" class="progress-cell">
                <div class="progress-info">
                  <div class="progress-header">
                    <span class="progress-text">{{ transfer.percentage }}%</span>
                    <span class="size-text"
                      >{{ formatFileSize(transfer.bytes) }} /
                      {{ formatFileSize(transfer.size) }}</span
                    >
                  </div>
                  <mat-progress-bar
                    mode="determinate"
                    [value]="transfer.percentage"
                    [color]="getProgressColor(transfer)"
                    class="progress-bar"
                  >
                  </mat-progress-bar>
                </div>
              </td>
            </ng-container>

            <!-- Speed Column -->
            <ng-container matColumnDef="speed">
              <th mat-header-cell *matHeaderCellDef>Speed</th>
              <td mat-cell *matCellDef="let transfer" class="speed-cell">
                <div class="speed-info">
                  @if (transfer.speed > 0) {
                    <span class="speed-value">{{ formatFileSize(transfer.speed) }}/s</span>
                    <div class="speed-indicator" [ngClass]="getSpeedClass(transfer.speed)"></div>
                  } @else {
                    <span class="speed-idle">-</span>
                  }
                </div>
              </td>
            </ng-container>

            <!-- ETA Column -->
            <ng-container matColumnDef="eta">
              <th mat-header-cell *matHeaderCellDef>ETA</th>
              <td mat-cell *matCellDef="let transfer" class="eta-cell">
                @if (transfer.eta > 0 && !transfer.isCompleted) {
                  <span class="eta-value">{{ formatTime(transfer.eta) }}</span>
                } @else {
                  <span class="eta-complete">-</span>
                }
              </td>
            </ng-container>

            <tr mat-header-row *matHeaderRowDef="displayedColumns; sticky: true"></tr>
            <tr
              mat-row
              *matRowDef="let row; columns: displayedColumns"
              class="transfer-row"
              [ngClass]="{
                completed: row.isCompleted,
                error: row.isError,
                active: !row.isCompleted && !row.isError,
              }"
            ></tr>
          </table>
        </cdk-virtual-scroll-viewport>
      } @else {
        <div class="no-transfers">
          <mat-icon svgIcon="download" class="no-transfers-icon"></mat-icon>
          <span>No active transfers</span>
        </div>
      }
    </div>
  `,
  styleUrls: ['./active-transfers-table.component.scss'],
})
export class ActiveTransfersTableComponent {
  @Input() transfers: TransferFile[] = [];
  @Input() operationClass = '';
  @Input() trackBy?: (index: number, transfer: TransferFile) => string;

  defaultTrackBy(index: number, transfer: TransferFile): string {
    return transfer.name + transfer.percentage;
  }

  displayedColumns: string[] = ['name', 'progress', 'speed', 'eta'];

  getFileName(path: string): string {
    return path.split('/').pop() || path;
  }

  getProgressColor(transfer: TransferFile): string {
    if (transfer.isError) return 'warn';
    if (transfer.isCompleted) return 'accent';
    return 'primary';
  }

  getSpeedClass(speed: number): string {
    if (speed > 10 * 1024 * 1024) return 'speed-fast'; // > 10MB/s
    if (speed > 1 * 1024 * 1024) return 'speed-medium'; // > 1MB/s
    return 'speed-slow';
  }

  formatFileSize(bytes: number): string {
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0)} ${units[i]}`;
  }

  formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds <= 0) return '-';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  }
}

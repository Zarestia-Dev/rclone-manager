import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatChipsModule } from '@angular/material/chips';

import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';
import { CompletedTransfer } from '@app/types';
import { FormatTimePipe } from '../../pipes/format-time.pipe';

@Component({
  selector: 'app-completed-transfers-table',
  imports: [CommonModule, MatTableModule, MatIconModule, MatTooltipModule, MatChipsModule],
  template: `
    <div class="transfer-table-container">
      @if (transfers().length > 0) {
        <div class="transfer-viewport">
          <table mat-table [dataSource]="transfers()" class="transfer-table">
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
                </div>
              </td>
            </ng-container>

            <!-- Status Column -->
            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef>Status</th>
              <td mat-cell *matCellDef="let transfer" class="status-cell">
                @if (transfer.status === 'failed') {
                  <mat-chip class="status-chip error">
                    <span>
                      <mat-icon svgIcon="circle-exclamation" class="chip-icon"></mat-icon>
                      Failed
                    </span>
                  </mat-chip>
                } @else if (transfer.status === 'checked') {
                  <mat-chip class="status-chip checked">
                    <span>
                      <mat-icon svgIcon="circle-check" class="chip-icon accent"></mat-icon>
                      Checked
                    </span>
                  </mat-chip>
                } @else if (transfer.status === 'partial') {
                  <mat-chip class="status-chip partial">
                    <span>
                      <mat-icon svgIcon="circle-exclamation" class="chip-icon warn"></mat-icon>
                      Partial
                    </span>
                  </mat-chip>
                } @else {
                  <mat-chip class="status-chip success">
                    <span>
                      <mat-icon svgIcon="circle-check" class="chip-icon accent"></mat-icon>
                      Completed
                    </span>
                  </mat-chip>
                }
              </td>
            </ng-container>

            <!-- Size Column -->
            <ng-container matColumnDef="size">
              <th mat-header-cell *matHeaderCellDef>Size</th>
              <td mat-cell *matCellDef="let transfer" class="size-cell">
                <div class="size-info">
                  <span class="size-value">{{ FormatFileSizePipe.transform(transfer.size) }}</span>
                  @if (transfer.bytes !== transfer.size && transfer.bytes > 0) {
                    <span class="size-transferred"
                      >({{ FormatFileSizePipe.transform(transfer.bytes) }} transferred)</span
                    >
                  }
                  @if (transfer.status === 'checked' && transfer.size > 0) {
                    <span class="size-note"> (already existed)</span>
                  }
                </div>
              </td>
            </ng-container>

            <!-- Path Column -->
            <ng-container matColumnDef="path">
              <th mat-header-cell *matHeaderCellDef>Path</th>
              <td mat-cell *matCellDef="let transfer" class="path-cell">
                <div class="path-info">
                  @if (transfer.srcFs && transfer.dstFs) {
                    <span class="src" matTooltip="Source: {{ transfer.srcFs }}">{{
                      transfer.srcFs
                    }}</span>
                    <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>
                    <span class="dst" matTooltip="Destination: {{ transfer.dstFs }}">{{
                      transfer.dstFs
                    }}</span>
                  } @else {
                    <span class="no-path">-</span>
                  }
                </div>
              </td>
            </ng-container>

            <!-- Time Column -->
            <ng-container matColumnDef="time">
              <th mat-header-cell *matHeaderCellDef>Completed</th>
              <td mat-cell *matCellDef="let transfer" class="time-cell">
                <div class="time-info">
                  @if (transfer.completedAt) {
                    <span class="time-relative">{{ getRelativeTime(transfer.completedAt) }}</span>
                  } @else {
                    <span class="time-value">-</span>
                  }
                  @if (
                    transfer.startedAt && transfer.completedAt && transfer.status === 'completed'
                  ) {
                    <span class="duration">{{
                      getDuration(transfer.startedAt, transfer.completedAt)
                    }}</span>
                  }
                </div>
              </td>
            </ng-container>

            <!-- Job ID Column -->
            <ng-container matColumnDef="jobid">
              <th mat-header-cell *matHeaderCellDef>Job</th>
              <td mat-cell *matCellDef="let transfer" class="jobid-cell">
                <mat-chip class="job-chip" matTooltip="Job ID: {{ transfer.jobid }}">
                  #{{ transfer.jobid }}
                </mat-chip>
              </td>
            </ng-container>

            <tr mat-header-row *matHeaderRowDef="displayedColumns; sticky: true"></tr>
            <tr
              mat-row
              *matRowDef="let row; columns: displayedColumns"
              class="transfer-row"
              [ngClass]="{
                error: row.status === 'failed',
                checked: row.status === 'checked',
                partial: row.status === 'partial',
                success: row.status === 'completed',
              }"
            ></tr>
          </table>
        </div>
      } @else {
        <div class="empty-state">
          <mat-icon svgIcon="circle-check" class="placeholder-icon"></mat-icon>
          <span>No recent completed transfers</span>
          <p>Completed transfers will appear here once operations finish</p>
        </div>
      }
    </div>
  `,
  styleUrls: ['./transfer-tables.scss'],
})
export class CompletedTransfersTableComponent {
  transfers = input.required<CompletedTransfer[]>();
  operationClass = input('');
  trackBy = input<(index: number, transfer: CompletedTransfer) => string>();

  FormatFileSizePipe = new FormatFileSizePipe();
  FormatTimePipe = new FormatTimePipe();

  defaultTrackBy(_index: number, transfer: CompletedTransfer): string {
    return transfer.name + transfer.completedAt;
  }

  displayedColumns: string[] = ['name', 'status', 'size', 'path', 'time', 'jobid'];

  getFileName(path: string): string {
    return path.split('/').pop() || path;
  }

  getRelativeTime(timestamp: string): string {
    const now = Date.now();
    const time = new Date(timestamp).getTime();
    const diff = now - time;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  }

  getDuration(startedAt: string, completedAt: string): string {
    const start = new Date(startedAt).getTime();
    const end = new Date(completedAt).getTime();
    const diff = end - start;

    if (diff < 1000) return '<1s';

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}

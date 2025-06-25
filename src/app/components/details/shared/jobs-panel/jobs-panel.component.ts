import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSortModule } from '@angular/material/sort';
import { JobInfo } from '../../../../shared/components/types';

export interface JobsPanelConfig {
  jobs: JobInfo[];
  displayedColumns: string[];
}

@Component({
  selector: 'app-jobs-panel',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatTableModule,
    MatButtonModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatSortModule
  ],
  styleUrls: ['./jobs-panel.component.scss'],
  template: `
    <mat-card class="detail-panel jobs-panel">
      <mat-card-header class="panel-header">
        <mat-card-title class="panel-title-content">
          <mat-icon svgIcon="jobs" class="panel-icon"></mat-icon>
          <span>Active Jobs</span>
          <span class="count">{{ config.jobs.length }}</span>
        </mat-card-title>
      </mat-card-header>
      <mat-card-content class="panel-content">
        <div class="jobs-table-container">
          <table mat-table [dataSource]="config.jobs" matSort class="jobs-table">
            <!-- Type Column -->
            <ng-container matColumnDef="type">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Type</th>
              <td class="type-column" mat-cell *matCellDef="let job">
                <div class="job-type-info">
                  <span class="job-type-text">{{ job.job_type | titlecase }}</span>
                </div>
              </td>
            </ng-container>

            <!-- Status Column -->
            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Status</th>
              <td mat-cell *matCellDef="let job">
                <div class="status-chip" [ngClass]="getJobStatus(job)">
                  <div class="status-dot"></div>
                  <span>{{ job.status | titlecase }}</span>
                </div>
              </td>
            </ng-container>

            <!-- Progress Column -->
            <ng-container matColumnDef="progress">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Progress</th>
              <td mat-cell *matCellDef="let job">
                @if (job.job_type !== 'mount' && job.stats) {
                  <div class="progress-info">
                    <mat-progress-bar mode="determinate" [value]="getJobProgress(job)"
                      class="job-progress"></mat-progress-bar>
                    <span class="progress-text">
                      {{ formatBytes(job.stats.bytes) }} / {{ formatBytes(job.stats.totalBytes) }}
                    </span>
                  </div>
                } @else {
                  <span class="no-progress">-</span>
                }
              </td>
            </ng-container>

            <!-- Start Time Column -->
            <ng-container matColumnDef="startTime">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>Started</th>
              <td mat-cell *matCellDef="let job">
                <span class="start-time">{{ job.start_time | date:'short' }}</span>
              </td>
            </ng-container>

            <!-- Actions Column -->
            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef>Actions</th>
              <td mat-cell *matCellDef="let job">
                <div class="job-actions">
                  @if (job.status === 'Running') {
                    <button mat-icon-button class="action-button stop-button" matTooltip="Stop Job"
                      (click)="onStopJob(job)">
                      <mat-icon svgIcon="stop"></mat-icon>
                    </button>
                  } @else {
                    <button mat-icon-button class="action-button delete-button" matTooltip="Delete Job"
                      (click)="onDeleteJob(job.jobid)">
                      <mat-icon svgIcon="trash"></mat-icon>
                    </button>
                  }
                </div>
              </td>
            </ng-container>

            <tr mat-header-row *matHeaderRowDef="config.displayedColumns"></tr>
            <tr mat-row *matRowDef="let row; columns: config.displayedColumns;" class="job-row"></tr>
            <tr class="no-data-row" *matNoDataRow>
              <td class="no-data-cell" [attr.colspan]="config.displayedColumns.length">
                <div class="no-data-content">
                  <mat-icon svgIcon="jobs" class="no-data-icon"></mat-icon>
                  <span>No active jobs</span>
                </div>
              </td>
            </tr>
          </table>
        </div>
      </mat-card-content>
    </mat-card>
  `,
})
export class JobsPanelComponent {
  @Input() config!: JobsPanelConfig;

  @Output() stopOperation = new EventEmitter<{
    type: "sync" | "copy" | "mount" | string;
    remoteName: string;
  }>();
  @Output() deleteJob = new EventEmitter<number>();

  onStopJob(job: JobInfo): void {
    this.stopOperation.emit({
      type: job.job_type,
      remoteName: job.remote_name
    });
  }

  onDeleteJob(jobId: number): void {
    this.deleteJob.emit(jobId);
  }

  getJobProgress(job: JobInfo): number {
    if (!job.stats) return 0;
    return (job.stats.bytes / job.stats.totalBytes) * 100;
  }

  getJobStatus(job: JobInfo): string {
    switch (job.status) {
      case "Running":
        return "running";
      case "Completed":
        return "completed";
      case "Failed":
        return "failed";
      case "Stopped":
        return "stopped";
      default:
        return "unknown";
    }
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }
}

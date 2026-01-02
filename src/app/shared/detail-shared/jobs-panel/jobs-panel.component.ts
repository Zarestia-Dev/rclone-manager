import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSortModule } from '@angular/material/sort';
import { JobInfo, JobsPanelConfig, PrimaryActionType } from '../../types';
import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';

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
    MatSortModule,
    FormatFileSizePipe,
    TranslateModule,
  ],
  styleUrls: ['./jobs-panel.component.scss'],
  template: `
    <mat-card>
      <mat-card-header>
        <mat-card-title>
          <mat-icon svgIcon="jobs"></mat-icon>
          <span>{{ 'detailShared.jobs.activeJobs' | translate }}</span>
          <span class="count">{{ config().jobs.length }}</span>
        </mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <div class="jobs-table-container">
          <table mat-table [dataSource]="config().jobs" matSort class="jobs-table">
            <!-- Type Column -->
            <ng-container matColumnDef="type">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>
                {{ 'detailShared.jobs.columns.type' | translate }}
              </th>
              <td class="type-column" mat-cell *matCellDef="let job">
                <div class="job-type-info">
                  <span class="job-type-text">{{ job.job_type | titlecase }}</span>
                </div>
              </td>
            </ng-container>

            <!-- Profile Column -->
            <ng-container matColumnDef="profile">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>
                {{ 'detailShared.jobs.columns.profile' | translate }}
              </th>
              <td mat-cell *matCellDef="let job">
                <span class="profile-name">{{ job.profile || 'default' }}</span>
              </td>
            </ng-container>

            <!-- Status Column -->
            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>
                {{ 'detailShared.jobs.columns.status' | translate }}
              </th>
              <td mat-cell *matCellDef="let job">
                <div class="status-chip" [ngClass]="getJobStatus(job)">
                  <div class="status-dot"></div>
                  <span>{{
                    'detailShared.jobs.status.' + (getJobStatus(job) | lowercase) | translate
                  }}</span>
                </div>
              </td>
            </ng-container>

            <!-- Progress Column -->
            <ng-container matColumnDef="progress">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>
                {{ 'detailShared.jobs.columns.progress' | translate }}
              </th>
              <td mat-cell *matCellDef="let job">
                @if (job.job_type !== 'mount' && job.stats) {
                  <div class="progress-info">
                    <mat-progress-bar
                      mode="determinate"
                      [value]="getJobProgress(job)"
                      class="job-progress"
                    ></mat-progress-bar>
                    <span class="progress-text">
                      {{ job.stats.bytes | formatFileSize }} /
                      {{ job.stats.totalBytes | formatFileSize }}
                    </span>
                  </div>
                } @else {
                  <span class="no-progress">-</span>
                }
              </td>
            </ng-container>

            <!-- Start Time Column -->
            <ng-container matColumnDef="startTime">
              <th mat-header-cell *matHeaderCellDef mat-sort-header>
                {{ 'detailShared.jobs.columns.started' | translate }}
              </th>
              <td mat-cell *matCellDef="let job">
                <span class="start-time">{{ job.start_time | date: 'short' }}</span>
              </td>
            </ng-container>

            <!-- Actions Column -->
            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef>
                {{ 'detailShared.jobs.columns.actions' | translate }}
              </th>
              <td mat-cell *matCellDef="let job">
                <div class="job-actions">
                  @if (job.status === 'Running') {
                    <button
                      matIconButton
                      tabIndex="-1"
                      class="action-button stop-button"
                      [matTooltip]="'detailShared.jobs.actions.stop' | translate"
                      (click)="
                        stopJob.emit({
                          type: job.job_type,
                          remoteName: job.remote_name,
                          profileName: job.profile,
                        })
                      "
                    >
                      <mat-icon svgIcon="stop"></mat-icon>
                    </button>
                  } @else {
                    <button
                      matIconButton
                      tabIndex="-1"
                      class="action-button delete-button"
                      [matTooltip]="'detailShared.jobs.actions.delete' | translate"
                      (click)="deleteJob.emit(job.jobid)"
                    >
                      <mat-icon svgIcon="trash"></mat-icon>
                    </button>
                  }
                </div>
              </td>
            </ng-container>

            <tr mat-header-row *matHeaderRowDef="config().displayedColumns"></tr>
            <tr
              mat-row
              *matRowDef="let row; columns: config().displayedColumns"
              class="job-row"
            ></tr>
            <tr class="no-data-row" *matNoDataRow>
              <td class="no-data-cell" [attr.colspan]="config().displayedColumns.length">
                <div class="no-data-content">
                  <mat-icon svgIcon="jobs" class="no-data-icon"></mat-icon>
                  <span>{{ 'detailShared.jobs.empty' | translate }}</span>
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
  config = input.required<JobsPanelConfig>();

  stopJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();
  deleteJob = output<number>();

  getJobProgress(job: JobInfo): number {
    if (!job.stats) return 0;
    return (job.stats.bytes / job.stats.totalBytes) * 100;
  }

  getJobStatus(job: JobInfo): string {
    return job.status.toLowerCase();
  }
}

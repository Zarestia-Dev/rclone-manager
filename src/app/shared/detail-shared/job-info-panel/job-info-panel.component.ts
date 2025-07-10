import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';

export interface JobInfoConfig {
  operationType: string;
  jobId?: number;
  startTime?: Date;
  lastOperationTime?: string;
}

@Component({
  selector: 'app-job-info-panel',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatIconModule],
  styleUrls: ['./job-info-panel.component.scss'],
  template: `
    <mat-card class="detail-panel job-info-panel">
      <mat-card-header class="panel-header">
        <mat-card-title class="panel-title-content">
          <mat-icon svgIcon="info" class="panel-icon"></mat-icon>
          <span>Job Information</span>
        </mat-card-title>
      </mat-card-header>

      <mat-card-content class="panel-content">
        <div class="job-details-grid">
          <div class="job-detail-item">
            <div class="detail-label">Job Type</div>
            <div class="detail-value">{{ config.operationType | titlecase }}</div>
          </div>

          <div class="job-detail-item">
            <div class="detail-label">Job ID</div>
            <div class="detail-value">{{ config.jobId || 'N/A' }}</div>
          </div>

          @if (config.startTime) {
            <div class="job-detail-item">
              <div class="detail-label">Started</div>
              <div class="detail-value">{{ config.startTime | date: 'medium' }}</div>
            </div>
          }

          <div class="job-detail-item">
            <div class="detail-label">Last Operation</div>
            <div class="detail-value">{{ config.lastOperationTime || 'N/A' }}</div>
          </div>
        </div>
      </mat-card-content>
    </mat-card>
  `,
})
export class JobInfoPanelComponent {
  @Input() config!: JobInfoConfig;
}

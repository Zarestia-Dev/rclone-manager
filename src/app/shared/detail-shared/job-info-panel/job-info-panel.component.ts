import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { JobInfoConfig } from '../../types';

@Component({
  selector: 'app-job-info-panel',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatIconModule, TranslateModule],
  styleUrls: ['./job-info-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card>
      <mat-card-header>
        <mat-card-title>
          <mat-icon svgIcon="info"></mat-icon>
          <span>{{ 'detailShared.jobInfo.title' | translate }}</span>
        </mat-card-title>
      </mat-card-header>

      <mat-card-content>
        @if (config().jobId) {
          <div class="job-details-grid">
            <div class="job-detail-item">
              <div class="detail-label">{{ 'detailShared.jobInfo.type' | translate }}</div>
              <div class="detail-value">{{ config().operationType | titlecase }}</div>
            </div>

            <div class="job-detail-item">
              <div class="detail-label">{{ 'detailShared.jobInfo.id' | translate }}</div>
              <div class="detail-value">{{ config().jobId }}</div>
            </div>

            @if (config().startTime) {
              <div class="job-detail-item">
                <div class="detail-label">{{ 'detailShared.jobInfo.started' | translate }}</div>
                <div class="detail-value">{{ config().startTime | date: 'medium' }}</div>
              </div>
            }

            <div class="job-detail-item">
              <div class="detail-label">{{ 'detailShared.jobInfo.lastOperation' | translate }}</div>
              <div class="detail-value">{{ config().lastOperationTime || 'N/A' }}</div>
            </div>
          </div>
        } @else {
          <div class="empty-state">
            <mat-icon svgIcon="info"></mat-icon>
            <span>{{ 'detailShared.jobInfo.emptyTitle' | translate }}</span>
            <p>{{ 'detailShared.jobInfo.emptyMessage' | translate }}</p>
          </div>
        }
      </mat-card-content>
    </mat-card>
  `,
})
export class JobInfoPanelComponent {
  config = input.required<JobInfoConfig>();
}

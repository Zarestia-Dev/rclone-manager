import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { DatePipe, TitleCasePipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { JobInfoConfig } from '../../types';

@Component({
  selector: 'app-job-info-panel',
  standalone: true,
  imports: [DatePipe, TitleCasePipe, MatCardModule, MatIconModule, TranslateModule],
  styleUrls: ['./job-info-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card>
      <mat-card-header>
        <mat-card-title>
          <mat-icon svgIcon="info" style="color: var(--mat-sys-primary);"></mat-icon>
          <span>{{ 'detailShared.jobInfo.title' | translate }}</span>
        </mat-card-title>
      </mat-card-header>

      <mat-card-content>
        <div class="job-details-grid">
          <div class="job-detail-item">
            <div class="detail-label">{{ 'detailShared.jobInfo.type' | translate }}</div>
            <div class="detail-value">{{ config().operationType | titlecase }}</div>
          </div>

          @if (config().jobId) {
            <div class="job-detail-item">
              <div class="detail-label">{{ 'detailShared.jobInfo.id' | translate }}</div>
              <div class="detail-value"># {{ config().jobId }}</div>
            </div>
          }

          @if (config().status) {
            <div class="job-detail-item">
              <div class="detail-label">{{ 'detailShared.jobInfo.status' | translate }}</div>
              <div
                class="detail-value status-value"
                [class]="'status-' + config().status?.toLowerCase()"
              >
                {{ config().status | titlecase }}
              </div>
            </div>
          }

          @if (config().startTime) {
            <div class="job-detail-item">
              <div class="detail-label">{{ 'detailShared.jobInfo.started' | translate }}</div>
              <div class="detail-value">{{ config().startTime | date: 'medium' }}</div>
            </div>
          }

          @if (config().endTime) {
            <div class="job-detail-item">
              <div class="detail-label">{{ 'detailShared.jobInfo.finished' | translate }}</div>
              <div class="detail-value">{{ config().endTime | date: 'medium' }}</div>
            </div>
          }

          @if (config().duration) {
            <div class="job-detail-item">
              <div class="detail-label">{{ 'detailShared.jobInfo.duration' | translate }}</div>
              <div class="detail-value">{{ config().duration }}</div>
            </div>
          }
        </div>
      </mat-card-content>
    </mat-card>
  `,
})
export class JobInfoPanelComponent {
  readonly config = input.required<JobInfoConfig>();
}

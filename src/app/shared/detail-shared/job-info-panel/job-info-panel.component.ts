import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { JobInfoConfig } from '../../types';

@Component({
  selector: 'app-job-info-panel',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatIconModule, MatSelectModule, MatFormFieldModule],
  styleUrls: ['./job-info-panel.component.scss'],
  template: `
    <mat-card>
      <mat-card-header>
        <mat-card-title>
          <mat-icon svgIcon="info"></mat-icon>
          <span>Job Information</span>
        </mat-card-title>

        @if (config.showProfileSelector && config.profiles && config.profiles.length > 1) {
          <div class="profile-selector-header">
            <mat-form-field class="profile-select">
              <mat-select
                [value]="config.selectedProfile"
                (selectionChange)="profileChange.emit($event.value)"
              >
                @for (profile of config.profiles; track profile.name) {
                  <mat-option [value]="profile.name">
                    {{ profile.label }}
                  </mat-option>
                }
              </mat-select>
            </mat-form-field>
          </div>
        }
      </mat-card-header>

      <mat-card-content>
        @if (config.jobId) {
          <div class="job-details-grid">
            <div class="job-detail-item">
              <div class="detail-label">Job Type</div>
              <div class="detail-value">{{ config.operationType | titlecase }}</div>
            </div>

            <div class="job-detail-item">
              <div class="detail-label">Job ID</div>
              <div class="detail-value">{{ config.jobId }}</div>
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
        } @else {
          <div class="empty-state">
            <mat-icon svgIcon="info"></mat-icon>
            <span>No active job</span>
            <p>Job details will appear here when an operation starts</p>
          </div>
        }
      </mat-card-content>
    </mat-card>
  `,
})
export class JobInfoPanelComponent {
  @Input() config!: JobInfoConfig;
  @Output() profileChange = new EventEmitter<string>();
}

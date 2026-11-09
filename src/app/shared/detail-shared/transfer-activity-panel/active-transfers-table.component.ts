import { ActivityPathsComponent } from './activity-paths.component';
import { Component, input, ChangeDetectionStrategy, computed } from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import {
  CHECK_OPERATIONS,
  DELETE_OPERATIONS,
  JOB_ICON_MAP,
  JobActionType,
  TransferFile,
} from '@app/types';
import { TransferOperationsService } from './transfer-operations.service';
import { matchesActivitySearch, splitPath } from './activity.utils';

import { PillDirective } from '../../directives/pill.directive';
interface ActiveRow extends TransferFile {
  isPreparing: boolean;
  uniqueId: string;
}

@Component({
  selector: 'app-active-transfers-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [TransferOperationsService],
  imports: [
    ActivityPathsComponent,
    MatProgressBarModule,
    MatIconModule,
    TranslatePipe,
    FormatFileSizePipe,
    FormatTimePipe,
    PillDirective,
  ],
  template: `
    <div class="card-list-container">
      @if (enrichedTransfers().length > 0 || filteredChecks().length > 0) {
        <!-- Checks are stateless display slots: rclone replaces their names as work advances. -->
        @for (name of filteredChecks(); track $index) {
          <div class="card-row-item">
            <div class="card-header">
              <div class="card-info-left">
                <mat-icon svgIcon="file" class="card-primary-icon"></mat-icon>
                <span class="card-title" [title]="name">
                  <span class="file-dir truncate">{{ splitName(name).dir }}</span>
                  <span class="card-title-text truncate">{{ splitName(name).base }}</span>
                </span>
              </div>
              <div class="card-info-right">
                <span appPill tone="accent">{{ checkLabel() | translate }}</span>
              </div>
            </div>
          </div>
        }
        @for (transfer of enrichedTransfers(); track transfer.uniqueId) {
          <div class="card-row-item">
            <div class="card-header">
              <div class="card-info-left">
                <mat-icon svgIcon="file" class="card-primary-icon"></mat-icon>
                <span class="card-title" [title]="transfer.name">
                  <span class="file-dir truncate">{{ splitName(transfer.name).dir }}</span>
                  <span class="card-title-text truncate">{{ splitName(transfer.name).base }}</span>
                </span>
              </div>
              <div class="card-info-right"></div>
            </div>

            <div class="card-progress">
              <mat-progress-bar
                [mode]="transfer.isPreparing ? 'indeterminate' : 'determinate'"
                [value]="transfer.isPreparing ? 0 : transfer.percentage"
              ></mat-progress-bar>
              @if (transfer.isPreparing) {
                <span class="percentage-text preparing">{{
                  'shared.transferActivity.status.preparing' | translate
                }}</span>
              } @else if (transfer.percentage === 100) {
                <span class="percentage-text finalizing">{{
                  'shared.transferActivity.status.finalizing' | translate
                }}</span>
              } @else {
                <span class="percentage-text">{{ transfer.percentage }}%</span>
              }
            </div>

            <div class="card-footer">
              <div class="card-footer-left">
                <span class="size-text">
                  {{ transfer.bytes | formatFileSize }}
                  @if (transfer.size >= 0) {
                    / {{ transfer.size | formatFileSize }}
                  }
                </span>
              </div>
              <div class="card-footer-right">
                @if (transfer.speed > 0) {
                  <span class="speed-text">{{ transfer.speed | formatFileSize }}/s</span>
                }
                @if (transfer.eta > 0) {
                  <span class="eta-text">{{ transfer.eta | formatTime }}</span>
                }
              </div>
            </div>

            <app-activity-paths
              [item]="transfer"
              [rowId]="transfer.uniqueId"
              [jobType]="jobType()"
              [fallbackLabel]="remoteName()"
            ></app-activity-paths>
          </div>
        }
      } @else if (searchTerm().trim()) {
        <div class="empty-state">
          <mat-icon svgIcon="search"></mat-icon>
          <span>{{ 'shared.search.title' | translate }}</span>
          <p>{{ 'shared.search.description' | translate }}</p>
        </div>
      } @else {
        <div class="empty-state">
          <mat-icon [svgIcon]="activityIcon()"></mat-icon>
          <span>{{ 'shared.transferActivity.empty.noActiveActivity' | translate }}</span>
          @if (isJobRunning()) {
            <p>{{ 'shared.transferActivity.empty.waitingActivity' | translate }}</p>
          }
        </div>
      }
    </div>
  `,
})
export class ActiveTransfersTableComponent {
  readonly transfers = input.required<TransferFile[]>();
  readonly jobType = input<JobActionType>('sync');
  readonly remoteName = input<string>('');
  readonly searchTerm = input('');
  readonly checks = input<string[]>([]);
  readonly isJobRunning = input(false);
  private readonly normalizedSearch = computed(() => this.searchTerm().toLowerCase().trim());
  protected readonly activityIcon = computed(() => JOB_ICON_MAP[this.jobType()] || 'operations');
  protected readonly checkLabel = computed(() => {
    if (DELETE_OPERATIONS.has(this.jobType())) return 'shared.transferActivity.status.deleting';
    if (CHECK_OPERATIONS.has(this.jobType())) return 'shared.transferActivity.status.checking';
    return 'shared.transferActivity.status.processing';
  });
  protected readonly filteredChecks = computed(() => {
    const search = this.normalizedSearch();
    return search
      ? this.checks().filter(name => name.toLowerCase().includes(search))
      : this.checks();
  });

  protected readonly splitName = splitPath;

  protected readonly enrichedTransfers = computed(() => {
    const search = this.normalizedSearch();
    const items = this.transfers();

    const filtered = search ? items.filter(t => matchesActivitySearch(t, search)) : items;

    return filtered.map<ActiveRow>(transfer => ({
      ...transfer,
      isPreparing:
        transfer.size < 0 || transfer.percentage == null || !Number.isFinite(transfer.percentage),
      percentage: Math.max(0, Math.min(100, transfer.percentage || 0)),
      speed: transfer.speedAvg ?? transfer.speed,
      uniqueId: `${transfer.group || ''}-${transfer.name}`,
    }));
  });
}

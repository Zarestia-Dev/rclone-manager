import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe, NgClass } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTableModule } from '@angular/material/table';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TranslatePipe } from '@ngx-translate/core';

import { AlertService } from 'src/app/services/alerts/alert.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { AlertHistoryFilter, AlertSeverity } from '@app/types';
import { SearchContainerComponent } from 'src/app/shared/components/search-container/search-container.component';

@Component({
  selector: 'app-alert-history',
  standalone: true,
  imports: [
    DatePipe,
    NgClass,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatTableModule,
    MatProgressSpinnerModule,
    TranslatePipe,
    SearchContainerComponent,
  ],
  template: `
    <div class="history-container">
      <div class="toolbar">
        <div class="quick-filters">
          <button
            class="app-pill interactive"
            [style]="getFilterStyle(undefined)"
            (click)="setSeverityFilter(undefined)"
          >
            {{ 'common.all' | translate }}
          </button>

          @for (sev of severities; track sev) {
            <button
              class="app-pill interactive"
              [style]="getFilterStyle(sev)"
              (click)="setSeverityFilter(sev)"
            >
              {{ 'alerts.severityLevels.' + sev | translate }}
            </button>
          }
        </div>

        <div class="stats-pill" [class.has-unread]="alerts.unacknowledged() > 0">
          <mat-icon svgIcon="bell"></mat-icon>
          <strong>{{ alerts.unacknowledged() }}</strong>
          <span>{{ 'alerts.unacknowledged' | translate }}</span>
        </div>

        <div class="spacer"></div>

        <button
          mat-icon-button
          [class.search-open]="searchVisible()"
          (click)="searchVisible.set(!searchVisible())"
          [matTooltip]="'shared.search.toggle' | translate"
        >
          <mat-icon svgIcon="search"></mat-icon>
        </button>

        <button
          mat-icon-button
          (click)="acknowledgeAll()"
          [disabled]="alerts.unacknowledged() === 0"
          [matTooltip]="'alerts.acknowledgeAll' | translate"
        >
          <mat-icon svgIcon="done-all"></mat-icon>
        </button>

        <button
          mat-icon-button
          (click)="clearHistory()"
          [disabled]="alerts.history().length === 0"
          [matTooltip]="'alerts.clearHistory' | translate"
        >
          <mat-icon svgIcon="trash"></mat-icon>
        </button>
      </div>

      <app-search-container
        [visible]="searchVisible()"
        [searchText]="alerts.searchTerm()"
        (searchTextChange)="alerts.searchTerm.set($event)"
      ></app-search-container>

      <!-- Active filter tags -->
      @if (hasActiveFilters()) {
        <div class="active-filter-tags">
          @if (alerts.filter().remote) {
            <button class="app-pill p-accent" (click)="clearFilter('remote')">
              <mat-icon svgIcon="server"></mat-icon>
              {{ alerts.filter().remote }}
              <mat-icon svgIcon="circle-xmark"></mat-icon>
            </button>
          }
          @if (alerts.filter().profile) {
            <button class="app-pill p-primary" (click)="clearFilter('profile')">
              <mat-icon svgIcon="user"></mat-icon>
              {{ alerts.filter().profile }}
              <mat-icon svgIcon="circle-xmark"></mat-icon>
            </button>
          }
          @if (alerts.filter().backend) {
            <button class="app-pill p-dim" (click)="clearFilter('backend')">
              <mat-icon svgIcon="database"></mat-icon>
              {{ alerts.filter().backend }}
              <mat-icon svgIcon="circle-xmark"></mat-icon>
            </button>
          }
          <button mat-button (click)="clearFilters()">
            {{ 'common.clearAll' | translate }}
          </button>
        </div>
      }

      <!-- Table -->
      <div class="table-wrap" [class.loading]="alerts.isLoading()">
        <!-- Loading -->
        @if (alerts.isLoading() && alerts.history().length === 0) {
          <div class="empty-state">
            <mat-progress-spinner mode="indeterminate" diameter="32" strokeWidth="2">
            </mat-progress-spinner>
          </div>
        }

        <!-- Empty -->
        @if (!alerts.isLoading() && alerts.history().length === 0) {
          <div class="empty-state">
            <mat-icon svgIcon="bell"></mat-icon>
            <span>{{ 'alerts.noHistory' | translate }}</span>
            <p>{{ 'alerts.noHistoryDesc' | translate }}</p>
          </div>
        }

        <!-- Data -->
        @if (alerts.history().length > 0) {
          <table mat-table [dataSource]="alerts.history()">
            <!-- Severity -->
            <ng-container matColumnDef="severity">
              <th mat-header-cell *matHeaderCellDef>{{ 'alerts.severity' | translate }}</th>
              <td mat-cell *matCellDef="let alert">
                <span
                  class="severity-badge"
                  [style.color]="alerts.getSeverityStyle(alert.severity).color"
                  [style.background]="alerts.getSeverityStyle(alert.severity).bg"
                >
                  {{ 'alerts.severityLevels.' + alert.severity | translate }}
                </span>
              </td>
            </ng-container>

            <!-- Time -->
            <ng-container matColumnDef="time">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.time' | translate }}</th>
              <td mat-cell *matCellDef="let alert">
                <span class="date">{{ alert.timestamp | date: 'MMM d, y' }}</span>
                <span class="time-val">{{ alert.timestamp | date: 'HH:mm:ss' }}</span>
              </td>
            </ng-container>

            <!-- Content -->
            <ng-container matColumnDef="content">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.description' | translate }}</th>
              <td mat-cell *matCellDef="let alert">
                <div class="content-top">
                  <span class="alert-title">{{ alert.title }}</span>
                  @if (alert.operation) {
                    <span class="op-badge">{{ alert.operation }}</span>
                  }
                </div>
                <span class="alert-body">{{ alert.body }}</span>
              </td>
            </ng-container>

            <!-- Meta / context -->
            <ng-container matColumnDef="meta">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.context' | translate }}</th>
              <td mat-cell *matCellDef="let alert">
                <div class="meta-item" [matTooltip]="'alerts.ruleLabel' | translate">
                  <mat-icon svgIcon="check-list"></mat-icon>
                  <span>{{ alert.rule_name }}</span>
                </div>
                @if (alert.profile) {
                  <div class="meta-item">
                    <mat-icon svgIcon="user"></mat-icon>
                    <span>{{ alert.profile }}</span>
                  </div>
                }
                @if (alert.remote) {
                  <div class="meta-item">
                    <mat-icon svgIcon="server"></mat-icon>
                    <span>{{ alert.remote }}</span>
                  </div>
                }
                @if (alert.backend) {
                  <div class="meta-item">
                    <mat-icon svgIcon="database"></mat-icon>
                    <span>{{ alert.backend }}</span>
                  </div>
                }
              </td>
            </ng-container>

            <!-- Row actions -->
            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let alert">
                <div class="row-actions">
                  <span class="app-pill p-dim event-pill">
                    {{ 'alerts.events.' + alert.event_kind | translate }}
                  </span>

                  @if (alert.action_results.length > 0) {
                    <div class="action-results">
                      @for (res of alert.action_results; track res.action_id) {
                        <mat-icon
                          [svgIcon]="res.success ? 'circle-check' : 'circle-xmark'"
                          [class]="res.success ? 'primary' : 'warn'"
                          [matTooltip]="res.action_name + (res.error ? ': ' + res.error : '')"
                        ></mat-icon>
                      }
                    </div>
                  }

                  <button
                    mat-icon-button
                    [class.btn-acked]="alert.acknowledged"
                    [disabled]="alert.acknowledged"
                    (click)="acknowledge(alert.id)"
                    [matTooltip]="'common.acknowledge' | translate"
                  >
                    <mat-icon svgIcon="circle-check"></mat-icon>
                  </button>
                </div>
              </td>
            </ng-container>

            <tr mat-header-row *matHeaderRowDef="displayedColumns; sticky: true"></tr>
            <tr
              mat-row
              *matRowDef="let row; columns: displayedColumns"
              [ngClass]="{ 'row-acked': row.acknowledged }"
              [style.--row-accent]="alerts.getSeverityStyle(row.severity).color"
            ></tr>
          </table>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
    }

    .history-container {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-sm) var(--space-md);
      flex-shrink: 0;
      flex-wrap: wrap;
    }

    .spacer {
      flex: 1;
    }

    .search-open {
      background: rgba(var(--accent-color-rgb), 0.1) !important;
      color: var(--accent-color) !important;
    }

    .quick-filters {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      flex-wrap: wrap;
    }

    .stats-pill {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      padding: 3px 10px;
      font-size: var(--font-size-sm);
      color: var(--dim-color);
      background: color-mix(in srgb, var(--window-fg-color) 4%, transparent);
      border-radius: var(--radius-md);
      box-shadow: 0 0 0 1px var(--border-color);
      transition:
        color 0.2s,
        background 0.2s,
        box-shadow 0.2s;

      mat-icon {
        width: 14px;
        height: 14px;
        font-size: 14px;
      }

      strong {
        font-weight: 700;
      }

      &.has-unread {
        color: var(--warn-color);
        background: rgba(var(--warn-color-rgb), 0.1);
        box-shadow: 0 0 0 1px rgba(var(--warn-color-rgb), 0.4);
      }
    }

    .active-filter-tags {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      padding: 0 var(--space-md) var(--space-sm);
      flex-wrap: wrap;
      flex-shrink: 0;
    }

    .table-wrap {
      flex: 1;
      overflow: auto;
      position: relative;
      border-top: 1px solid var(--border-color);
      transition: opacity 0.15s ease;

      &.loading {
        opacity: 0.5;
        pointer-events: none;
      }

      table {
        width: 100%;
        min-width: 800px;
      }
    }

    .mat-mdc-header-row {
      height: 44px;
    }

    .mat-mdc-header-cell {
      background: var(--window-bg-color) !important;
      position: sticky;
      top: 0;
      z-index: 2;
      border-bottom: 2px solid var(--border-color) !important;
      border-right: 1px solid var(--border-color);
      font-weight: 700;
      font-size: var(--font-size-xs);
      letter-spacing: 0.05em;
      color: var(--dim-color);
      white-space: nowrap;
      padding: 0 var(--space-sm) !important;
    }

    .mat-mdc-cell {
      padding: var(--space-sm) !important;
      border-bottom: 1px solid var(--border-color) !important;
      border-right: 1px solid var(--border-color);
      vertical-align: top;
    }

    .mat-mdc-row {
      border-left: 3px solid var(--row-accent, transparent);
      transition: background 0.1s ease;

      &:hover {
        background: var(--hover-bg-color);
      }
      &.row-acked {
        opacity: 0.45;
      }
    }

    .mat-column-severity {
      width: 88px;
    }
    .mat-column-time {
      width: 100px;
    }
    .mat-column-content {
      min-width: 260px;
    }
    .mat-column-meta {
      width: 170px;
    }
    .mat-column-actions {
      width: 160px;
    }

    .severity-badge {
      display: inline-block;
      font-size: var(--font-size-xs);
      font-weight: 700;
      padding: 2px 8px;
      border-radius: var(--radius-xxs);
      white-space: nowrap;
      letter-spacing: 0.03em;
    }

    .date {
      display: block;
      font-size: var(--font-size-xs);
      font-weight: 600;
      color: var(--window-fg-color);
      white-space: nowrap;
    }

    .time-val {
      display: block;
      font-size: var(--font-size-xs);
      color: var(--dim-color);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .content-top {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      min-width: 0;
      flex-wrap: wrap;
      margin-bottom: 2px;
    }

    .alert-title {
      font-size: var(--font-size-md);
      font-weight: 600;
      color: var(--window-fg-color);
      word-break: break-word;
    }

    .alert-body {
      font-size: var(--font-size-sm);
      color: var(--dim-color);
      word-break: break-word;
      line-height: 1.4;
    }

    .op-badge {
      display: inline-flex;
      align-items: center;
      padding: 1px var(--space-xs);
      border-radius: var(--radius-xxs);
      font-size: var(--font-size-xs);
      font-weight: 700;
      background: rgba(var(--purple-rgb), 0.12);
      color: var(--purple);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .meta-item {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: var(--font-size-sm);
      color: var(--dim-color);
      line-height: 1.6;

      mat-icon {
        width: var(--icon-size-sm);
        height: var(--icon-size-sm);
        font-size: var(--icon-size-sm);
        opacity: 0.6;
      }
    }

    .row-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-xs);
      padding: var(--space-xs) 0;
    }

    .event-pill {
      font-size: var(--font-size-xs) !important;
      padding: 1px 6px !important;
      min-height: unset !important;
    }

    .action-results {
      display: flex;
      align-items: center;
      gap: 3px;

      mat-icon {
        width: var(--icon-size-sm);
        height: var(--icon-size-sm);
        font-size: var(--icon-size-sm);
      }
    }

    .btn-acked {
      color: var(--primary-color) !important;
      opacity: 0.6;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertHistoryComponent {
  public readonly alerts = inject(AlertService);
  private readonly notificationService = inject(NotificationService);

  readonly searchVisible = signal(false);
  readonly displayedColumns = ['severity', 'time', 'content', 'meta', 'actions'];
  readonly severities: AlertSeverity[] = ['critical', 'high', 'average', 'warning', 'info'];

  // "All" pill active style (uses primary / green)
  private readonly allActiveStyle: Record<string, string> = {
    background: 'rgba(var(--primary-color-rgb), 0.12)',
    color: 'var(--primary-color)',
    'border-color': 'rgba(var(--primary-color-rgb), 0.3)',
  };

  readonly hasActiveFilters = computed(() => {
    const f = this.alerts.filter();
    return !!(f.remote || f.profile || f.backend);
  });

  getFilterStyle(severity: AlertSeverity | undefined): Record<string, string> {
    if (this.alerts.filter().severity !== severity) return {};
    if (!severity) return this.allActiveStyle;
    const s = this.alerts.getSeverityStyle(severity);
    return { background: s.bg, color: s.color, 'border-color': s.border };
  }

  setSeverityFilter(severity: AlertSeverity | undefined): void {
    this.alerts.filter.update(f => ({ ...f, severity: severity }));
    this.alerts.fetchHistory();
  }

  clearFilter(key: keyof AlertHistoryFilter): void {
    this.alerts.filter.update(f => {
      const u = { ...f };
      delete u[key];
      return u;
    });
    this.alerts.fetchHistory();
  }

  clearFilters(): void {
    this.alerts.filter.set({ limit: 100 });
    this.alerts.searchTerm.set('');
    this.alerts.fetchHistory();
  }

  async acknowledge(id: string): Promise<void> {
    await this.alerts.acknowledgeAlert(id);
  }

  async acknowledgeAll(): Promise<void> {
    await this.alerts.acknowledgeAllAlerts();
  }

  async clearHistory(): Promise<void> {
    const confirmed = await this.notificationService.confirmModal(
      'alerts.clearHistory',
      'alerts.clearHistoryConfirm',
      'common.delete',
      'common.cancel'
    );
    if (confirmed) {
      await this.alerts.clearAlertHistory();
    }
  }
}

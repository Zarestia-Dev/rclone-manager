import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTableModule } from '@angular/material/table';
import { TranslateModule } from '@ngx-translate/core';
import { AlertService, ModalService } from '@app/services';
import { AlertHistoryFilter, AlertSeverity } from '@app/types';
import { SearchContainerComponent } from '@app/shared/components';

@Component({
  selector: 'app-alert-history',
  standalone: true,
  imports: [
    DatePipe,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatTableModule,
    TranslateModule,
    SearchContainerComponent,
  ],
  template: `
    <div class="history-container">
      <!-- Toolbar -->
      <div class="toolbar">
        <div class="quick-filters">
          <button
            class="app-pill interactive"
            [class.primary]="!alerts.filter().severity_min"
            (click)="setSeverityFilter(undefined)"
          >
            {{ 'common.all' | translate }}
          </button>
          <button
            class="app-pill interactive"
            [class.warn]="alerts.filter().severity_min === 'critical'"
            (click)="setSeverityFilter('critical')"
          >
            <mat-icon svgIcon="circle-exclamation"></mat-icon>
            {{ 'alerts.severityLevels.critical' | translate }}
          </button>
          <button
            class="app-pill interactive"
            [class.orange]="alerts.filter().severity_min === 'high'"
            (click)="setSeverityFilter('high')"
          >
            <mat-icon svgIcon="warning"></mat-icon>
            {{ 'alerts.severityLevels.high' | translate }}
          </button>
          <button
            class="app-pill interactive"
            [class.accent]="alerts.filter().severity_min === 'average'"
            (click)="setSeverityFilter('average')"
          >
            <mat-icon svgIcon="circle-info"></mat-icon>
            {{ 'alerts.severityLevels.average' | translate }}
          </button>
        </div>

        <div class="stats-pill" [class.has-unread]="alerts.unacknowledged() > 0">
          <mat-icon svgIcon="bell"></mat-icon>
          <strong>{{ alerts.unacknowledged() }}</strong>
          <span>{{ 'alerts.unacknowledged' | translate }}</span>
        </div>

        <div class="spacer"></div>

        <button
          mat-icon-button
          [class.active]="searchVisible()"
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
          color="warn"
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

      <!-- Active Filters -->
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
          <button mat-button color="primary" (click)="clearFilters()">
            {{ 'common.clearAll' | translate }}
          </button>
        </div>
      }

      <!-- Alert Table -->
      <div class="alert-table-wrap" [class.loading]="alerts.isLoading()">
        @if (alerts.history().length === 0 && !alerts.isLoading()) {
          <div class="empty-state">
            <mat-icon svgIcon="bell"></mat-icon>
            <span>{{ 'alerts.noHistory' | translate }}</span>
            <p>{{ 'alerts.noHistoryDesc' | translate }}</p>
          </div>
        }

        @if (alerts.history().length > 0) {
          <table mat-table [dataSource]="alerts.history()">
            <!-- Severity Column -->
            <ng-container matColumnDef="severity">
              <th mat-header-cell *matHeaderCellDef>{{ 'alerts.severity' | translate }}</th>
              <td mat-cell *matCellDef="let alert">
                <div class="cell-content">
                  <span class="severity-badge" [class]="getSeverityClass(alert.severity)">
                    {{ 'alerts.severityLevels.' + alert.severity | translate }}
                  </span>
                </div>
              </td>
            </ng-container>

            <!-- Time Column -->
            <ng-container matColumnDef="time">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.time' | translate }}</th>
              <td mat-cell *matCellDef="let alert">
                <div class="cell-content">
                  <span class="date">{{ alert.timestamp | date: 'MMM d, y' }}</span>
                  <span class="time">{{ alert.timestamp | date: 'HH:mm:ss' }}</span>
                </div>
              </td>
            </ng-container>

            <!-- Content Column -->
            <ng-container matColumnDef="content">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.description' | translate }}</th>
              <td mat-cell *matCellDef="let alert">
                <div class="cell-content">
                  <div class="content-top">
                    <span class="alert-title">{{ alert.title }}</span>
                    @if (alert.operation) {
                      <span class="op-badge">{{ alert.operation }}</span>
                    }
                  </div>
                  <span class="alert-body">{{ alert.body }}</span>
                </div>
              </td>
            </ng-container>

            <!-- Meta Column -->
            <ng-container matColumnDef="meta">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.context' | translate }}</th>
              <td mat-cell *matCellDef="let alert">
                <div class="cell-content">
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
                </div>
              </td>
            </ng-container>

            <!-- Actions Column -->
            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let alert">
                <div class="cell-content actions-wrap">
                  <span class="app-pill p-dim event-kind-pill">
                    {{ 'alerts.events.' + alert.event_kind | translate }}
                  </span>
                  @if (alert.action_results.length > 0) {
                    <div class="action-results">
                      @for (res of alert.action_results; track res.action_id) {
                        <mat-icon
                          [svgIcon]="res.success ? 'circle-check' : 'circle-xmark'"
                          [class]="res.success ? 'primary' : 'warn'"
                          [matTooltip]="
                            (res.action_name | translate) + (res.error ? ': ' + res.error : '')
                          "
                        ></mat-icon>
                      }
                    </div>
                  }
                  <button
                    mat-icon-button
                    [class.acked]="alert.acknowledged"
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
              [class]="getSeverityClass(row.severity)"
              [class.acked]="row.acknowledged"
            ></tr>
          </table>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }

      .history-container {
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      /* ── Toolbar ─────────────────────────────────────── */
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

      .quick-filters {
        display: flex;
        align-items: center;
        gap: var(--space-xs);
        flex-wrap: wrap;
      }

      /* ── Stats Pill ──────────────────────────────────── */
      .stats-pill {
        display: flex;
        align-items: center;
        gap: var(--space-xs);
        padding: 3px 10px;
        font-size: var(--font-size-sm);
        color: var(--text-muted);
        background: var(--bg-elevated);
        border-radius: var(--radius-md);
        box-shadow: 0 0 0 1px var(--border-color);
        transition:
          color 0.2s,
          background 0.2s,
          border-color 0.2s;

        mat-icon {
          width: 14px;
          height: 14px;
          font-size: 14px;
        }

        &.has-unread {
          color: var(--warn-color);
          background: rgba(var(--warn-color-rgb), var(--active-opacity));
          box-shadow: 0 0 0 1px var(--warn-color);
        }
      }

      /* ── Active Filter Tags ──────────────────────────── */
      .active-filter-tags {
        display: flex;
        align-items: center;
        gap: var(--space-xs);
        padding: 0 var(--space-md) var(--space-sm);
        flex-wrap: wrap;
        flex-shrink: 0;
      }

      /* ── Table Layout ────────────────────────────────── */
      .alert-table-wrap {
        flex: 1;
        overflow: auto;
        position: relative;
        border-top: 1px solid var(--border-color);
        transition: opacity 0.15s ease;

        &.loading {
          opacity: 0.6;
          pointer-events: none;
        }

        table {
          width: 100%;
          min-width: 800px;
          border-collapse: separate;
          border-spacing: 0;
        }
      }

      .mat-mdc-header-row {
        height: 48px;
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
        color: var(--text-muted);
        white-space: nowrap;
      }

      .mat-mdc-cell {
        padding: 0 var(--space-sm) !important;
        border-bottom: 1px solid var(--border-color) !important;
        border-right: 1px solid var(--border-color);
        vertical-align: middle;

        &:last-child {
          border-right: none;
        }
      }

      .cell-content {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 2px;
        padding: 9px 0;
      }

      .actions-wrap {
        flex-direction: row;
        align-items: center;
        gap: var(--space-xs);
        flex-wrap: wrap;
      }

      /* ── Column Widths ────────────────────────────────── */
      .mat-column-severity {
        width: 88px;
      }
      .mat-column-time {
        width: 100px;
      }
      .mat-column-content {
        min-width: 280px;
      }
      .mat-column-meta {
        width: 180px;
      }
      .mat-column-actions {
        width: 148px;
      }

      /* ── Row Severity Accent ─────────────────────────── */
      .mat-mdc-row {
        transition: background 0.12s ease;

        &:hover {
          background: var(--bg-elevated);
        }

        &.acked {
          opacity: 0.55;
        }
      }

      /* ── Severity Badge ──────────────────────────────── */
      .severity-badge {
        font-size: var(--font-size-sm);
        font-weight: 700;
        padding: 2px 6px;
        border-radius: var(--radius-xxs);
        white-space: nowrap;
        align-self: flex-start;

        &.warn {
          background: color-mix(in srgb, var(--warn-color) 15%, transparent);
          color: var(--warn-color);
        }
        &.orange {
          background: color-mix(in srgb, var(--orange) 15%, transparent);
          color: var(--orange);
        }
        &.accent {
          background: color-mix(in srgb, var(--accent-color) 15%, transparent);
          color: var(--accent-color);
        }
        &.primary {
          background: color-mix(in srgb, var(--primary-color) 15%, transparent);
          color: var(--primary-color);
        }
        &.yellow {
          background: color-mix(in srgb, var(--yellow) 18%, transparent);
          color: color-mix(in srgb, var(--yellow) 70%, var(--window-fg-color));
        }
        &.dim {
          background: var(--bg-elevated);
          color: var(--text-muted);
        }
      }

      /* ── Time ────────────────────────────────────────── */
      .date {
        font-size: var(--font-size-xs);
        font-weight: 600;
        color: var(--window-fg-color);
        white-space: nowrap;
      }

      .time {
        font-size: var(--font-size-xs);
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      /* ── Content ─────────────────────────────────────── */
      .content-top {
        display: flex;
        align-items: center;
        gap: var(--space-xs);
        min-width: 0;
      }

      .alert-title {
        font-size: var(--font-size-md);
        font-weight: 600;
        color: var(--window-fg-color);
        word-break: break-word;
      }

      .alert-body {
        font-size: var(--font-size-sm);
        color: var(--text-muted);
        word-break: break-word;
      }

      .op-badge {
        display: inline-flex;
        align-items: center;
        padding: var(--space-xxs) var(--space-xs);
        border-radius: var(--radius-xxs);
        font-size: var(--font-size-xs);
        font-weight: 700;
        background: rgba(var(--purple-rgb), var(--active-opacity));
        color: var(--purple);
        white-space: nowrap;
        flex-shrink: 0;
      }

      /* ── Meta ────────────────────────────────────────── */
      .meta-item {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: var(--font-size-sm);
        color: var(--text-muted);

        mat-icon {
          width: var(--icon-size-sm);
          height: var(--icon-size-sm);
          font-size: var(--icon-size-sm);
          flex-shrink: 0;
        }
      }

      /* ── Action Results ──────────────────────────────── */
      .event-kind-pill {
        font-size: var(--font-size-xs) !important;
        padding: 2px 6px !important;
        min-height: unset !important;
      }

      .action-results {
        display: flex;
        gap: 3px;

        mat-icon {
          width: var(--icon-size-sm);
          height: var(--icon-size-sm);
          font-size: var(--icon-size-sm);

          &.primary {
            color: var(--primary-color);
          }
          &.warn {
            color: var(--warn-color);
          }
        }
      }

      /* ── Empty State ─────────────────────────────────── */
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 48px;
        gap: var(--space-sm);
        color: var(--text-muted);
        text-align: center;

        mat-icon {
          width: 48px;
          height: 48px;
          font-size: 48px;
          opacity: 0.2;
        }

        span {
          font-size: var(--font-size-lg);
          font-weight: 500;
        }

        p {
          font-size: var(--font-size-sm);
          margin: 0;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertHistoryComponent {
  public readonly alerts = inject(AlertService);
  private readonly modalService = inject(ModalService);

  readonly searchVisible = signal(false);
  readonly displayedColumns = ['severity', 'time', 'content', 'meta', 'actions'];

  /** Computed so it doesn't re-evaluate on every CD cycle as a plain method would. */
  readonly hasActiveFilters = computed(() => {
    const f = this.alerts.filter();
    return !!(f.remote || f.profile || f.backend);
  });

  setSeverityFilter(severity: AlertSeverity | undefined): void {
    this.alerts.filter.update(f => ({ ...f, severity_min: severity }));
  }

  clearFilter(key: keyof AlertHistoryFilter): void {
    this.alerts.filter.update(f => {
      const updated = { ...f };
      delete updated[key];
      return updated;
    });
  }

  clearFilters(): void {
    this.alerts.filter.set({ limit: 100 });
    this.alerts.searchTerm.set('');
  }

  getSeverityClass(severity: AlertSeverity): string {
    const map: Record<string, string> = {
      critical: 'warn',
      high: 'orange',
      average: 'accent',
      warning: 'yellow',
      info: 'primary',
    };
    return map[severity] ?? 'dim';
  }

  acknowledge(id: string): void {
    this.alerts.acknowledgeAlert(id).subscribe();
  }

  acknowledgeAll(): void {
    this.alerts.acknowledgeAllAlerts().subscribe();
  }

  clearHistory(): void {
    this.modalService
      .openConfirm({
        title: 'alerts.clearHistory',
        message: 'alerts.clearHistoryConfirm',
        confirmText: 'common.delete',
        cancelText: 'common.cancel',
      })
      .afterClosed()
      .subscribe(confirmed => {
        if (confirmed) this.alerts.clearAlertHistory().subscribe();
      });
  }
}

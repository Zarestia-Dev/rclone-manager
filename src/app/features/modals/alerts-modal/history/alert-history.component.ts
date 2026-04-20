import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { finalize } from 'rxjs';

import { AlertService, ModalService } from '@app/services';
import { AlertRecord, AlertStats } from '@app/types';

@Component({
  selector: 'app-alert-history',
  standalone: true,
  imports: [
    DatePipe,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    TranslateModule,
  ],
  template: `
    <div class="history-container">
      <div class="toolbar">
        @if (stats(); as s) {
          <div class="stats">
            <span class="stat-item">
              <strong>{{ s.unacknowledged }}</strong> {{ 'alerts.unacknowledged' | translate }}
            </span>
          </div>
        }
        <div class="actions">
          <button
            mat-stroked-button
            (click)="acknowledgeAll()"
            [disabled]="(stats()?.unacknowledged ?? 0) === 0"
          >
            <mat-icon svgIcon="done-all"></mat-icon>
            {{ 'alerts.acknowledgeAll' | translate }}
          </button>
          <button
            mat-stroked-button
            color="warn"
            (click)="clearHistory()"
            [disabled]="history().length === 0"
          >
            <mat-icon svgIcon="trash"></mat-icon>
            {{ 'alerts.clearHistory' | translate }}
          </button>
        </div>
      </div>

      <div class="table-wrapper boxed-list" [class.loading]="loading()">
        @if (history().length > 0) {
          <table mat-table [dataSource]="history()" class="history-table">
            <ng-container matColumnDef="severity">
              <th mat-header-cell *matHeaderCellDef>{{ 'alerts.severity' | translate }}</th>
              <td mat-cell *matCellDef="let alert">
                <span class="severity-badge" [class]="alert.severity">
                  {{ 'alerts.severityLevels.' + alert.severity | translate }}
                </span>
              </td>
            </ng-container>

            <ng-container matColumnDef="timestamp">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.time' | translate }}</th>
              <td mat-cell *matCellDef="let alert" class="time-cell">
                {{ alert.timestamp | date: 'short' }}
              </td>
            </ng-container>

            <ng-container matColumnDef="content">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.message' | translate }}</th>
              <td mat-cell *matCellDef="let alert">
                <div class="alert-content">
                  <div class="alert-title">{{ alert.title }}</div>
                  <div class="alert-body">{{ alert.body }}</div>
                </div>
              </td>
            </ng-container>

            <ng-container matColumnDef="origin">
              <th mat-header-cell *matHeaderCellDef>{{ 'alerts.rule.filters' | translate }}</th>
              <td mat-cell *matCellDef="let alert">
                @if (alert.origin) {
                  <span class="origin-badge" [class]="alert.origin">
                    {{ 'alerts.origins.' + alert.origin | translate }}
                  </span>
                }
              </td>
            </ng-container>

            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let alert">
                <div class="cell-actions">
                  @if (!alert.acknowledged) {
                    <button
                      mat-icon-button
                      (click)="acknowledge(alert.id)"
                      [matTooltip]="'common.ok' | translate"
                    >
                      <mat-icon svgIcon="circle-check"></mat-icon>
                    </button>
                  }
                </div>
              </td>
            </ng-container>

            <tr mat-header-row *matHeaderRowDef="displayedColumns; sticky: true"></tr>
            <tr
              mat-row
              *matRowDef="let row; columns: displayedColumns"
              [class.unacknowledged]="!row.acknowledged"
            ></tr>
          </table>
        } @else if (!loading()) {
          <div class="empty-state">
            <mat-icon svgIcon="clock-rotate-left"></mat-icon>
            <h3>{{ 'alerts.noHistory' | translate }}</h3>
            <p>Alert records will appear here when rules are triggered.</p>
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .history-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        gap: var(--space-md);
      }

      .toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;

        .stats {
          font-size: var(--font-size-md);
          color: var(--text-muted);
          strong {
            color: var(--window-fg-color);
            background: var(--bg-elevated);
            padding: 2px 8px;
            border-radius: 12px;
          }
        }

        .actions {
          display: flex;
          gap: var(--space-sm);
        }
      }

      .boxed-list {
        flex: 1;
        overflow: auto;
        border-radius: var(--card-border-radius);
        background: var(--card-bg-color);
        box-shadow: var(--shadow-gnome);

        &.loading {
          opacity: 0.6;
          pointer-events: none;
        }
      }

      .history-table {
        width: 100%;
        background: transparent;

        th.mat-mdc-header-cell {
          background: var(--card-bg-color);
          font-weight: 600;
          color: var(--text-muted);
          padding: var(--space-sm) var(--space-md);
        }

        td.mat-mdc-cell {
          padding: var(--space-sm) var(--space-md);
          border-bottom: 1px solid var(--border-color);
        }

        tr.mat-mdc-row {
          transition: background-color 0.2s ease;
          &:hover {
            background: var(--bg-hover);
          }
          &:last-child td {
            border-bottom: none;
          }
        }

        tr.unacknowledged {
          background: rgba(var(--accent-color-rgb), 0.04);
          &:hover {
            background: rgba(var(--accent-color-rgb), 0.08);
          }
        }

        .time-cell {
          white-space: nowrap;
          color: var(--text-muted);
          font-size: var(--font-size-sm);
        }

        .alert-content {
          display: flex;
          flex-direction: column;
          gap: 2px;

          .alert-title {
            font-weight: 600;
            font-size: var(--font-size-md);
            color: var(--window-fg-color);
          }
          .alert-body {
            font-size: var(--font-size-sm);
            color: var(--text-muted);
          }
        }

        .cell-actions {
          display: flex;
          justify-content: flex-end;
        }
      }

      .severity-badge {
        padding: 4px 10px;
        border-radius: 12px;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;

        &.critical {
          background: var(--warn-color);
          color: white;
        }
        &.high {
          background: var(--orange);
          color: white;
        }
        &.average {
          background: var(--accent-color);
          color: white;
        }
        &.warning {
          background: var(--yellow);
          color: rgba(0, 0, 0, 0.8);
        }
        &.info {
          background: var(--primary-color);
          color: white;
        }
      }

      .origin-badge {
        padding: 4px 8px;
        border-radius: 6px;
        font-size: 0.7rem;
        font-weight: 600;
        background: var(--bg-elevated);
        color: var(--text-muted);
        text-transform: uppercase;
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--space-2xl);
        color: var(--text-muted);
        text-align: center;
        height: 100%;

        mat-icon {
          width: 64px;
          height: 64px;
          margin-bottom: var(--space-md);
          opacity: 0.3;
        }

        h3 {
          margin: 0 0 var(--space-xs) 0;
          color: var(--window-fg-color);
          font-weight: 600;
        }

        p {
          margin: 0;
          font-size: var(--font-size-sm);
          max-width: 300px;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertHistoryComponent {
  private alertService = inject(AlertService);
  private modalService = inject(ModalService);

  history = signal<AlertRecord[]>([]);
  stats = signal<AlertStats | null>(null);
  loading = signal(false);

  displayedColumns = ['severity', 'timestamp', 'origin', 'content', 'actions'];

  constructor() {
    this.refresh();
  }

  refresh() {
    this.loading.set(true);
    this.alertService
      .getAlertHistory({ limit: 100 })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe(page => this.history.set(page.items));

    this.alertService.getAlertStats().subscribe(stats => this.stats.set(stats));
  }

  acknowledge(id: string) {
    this.alertService.acknowledgeAlert(id).subscribe(() => {
      this.refresh();
    });
  }

  acknowledgeAll() {
    this.alertService.acknowledgeAllAlerts().subscribe(() => {
      this.refresh();
    });
  }

  clearHistory() {
    this.modalService
      .openConfirm({
        title: 'alerts.clearHistory',
        message: 'alerts.clearHistoryConfirm',
        confirmText: 'common.delete',
        cancelText: 'common.cancel',
      })
      .afterClosed()
      .subscribe(confirmed => {
        if (confirmed) {
          this.alertService.clearAlertHistory().subscribe(() => this.refresh());
        }
      });
  }
}

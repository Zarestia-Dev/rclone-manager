import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatDialog } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import { finalize } from 'rxjs';

import { AlertService, ModalService } from '@app/services';
import { AlertRule } from '@app/types';
import { AlertRuleEditorComponent } from './alert-rule-editor.component';

@Component({
  selector: 'app-alert-rules',
  standalone: true,
  imports: [
    DatePipe,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatSlideToggleModule,
    TranslateModule,
  ],
  template: `
    <div class="rules-container">
      <div class="toolbar">
        <button mat-flat-button color="primary" (click)="createRule()">
          <mat-icon svgIcon="plus"></mat-icon>
          {{ 'alerts.createRule' | translate }}
        </button>
      </div>

      <div class="table-wrapper boxed-list" [class.loading]="loading()">
        @if (rules().length > 0) {
          <table mat-table [dataSource]="rules()" class="rules-table">
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef>{{ 'alerts.ruleName' | translate }}</th>
              <td mat-cell *matCellDef="let rule">
                <div class="rule-name">
                  <strong>{{ rule.name }}</strong>
                  @if (rule.last_fired) {
                    <span class="rule-meta">
                      {{ 'alerts.lastFired' | translate }}: {{ rule.last_fired | date: 'short' }}
                    </span>
                  }
                </div>
              </td>
            </ng-container>

            <ng-container matColumnDef="filters">
              <th mat-header-cell *matHeaderCellDef>{{ 'alerts.rule.filters' | translate }}</th>
              <td mat-cell *matCellDef="let rule">
                <div class="filter-chips">
                  <span class="severity-badge" [class]="rule.severity_min">
                    ≥ {{ 'alerts.severityLevels.' + rule.severity_min | translate }}
                  </span>
                  @if (rule.event_filter.length > 0) {
                    <span class="filter-badge event">
                      {{ rule.event_filter.length }} Event(s)
                    </span>
                  }
                  @if (rule.remote_filter.length > 0) {
                    <span class="filter-badge remote">
                      {{ rule.remote_filter.length }} Remote(s)
                    </span>
                  }
                </div>
              </td>
            </ng-container>

            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.status' | translate }}</th>
              <td mat-cell *matCellDef="let rule">
                <mat-slide-toggle
                  [checked]="rule.enabled"
                  (change)="toggleRule(rule)"
                ></mat-slide-toggle>
              </td>
            </ng-container>

            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let rule">
                <div class="cell-actions">
                  <button
                    mat-icon-button
                    (click)="editRule(rule)"
                    [matTooltip]="'common.edit' | translate"
                  >
                    <mat-icon svgIcon="pen"></mat-icon>
                  </button>
                  <button
                    mat-icon-button
                    color="warn"
                    (click)="deleteRule(rule)"
                    [matTooltip]="'common.delete' | translate"
                  >
                    <mat-icon svgIcon="trash"></mat-icon>
                  </button>
                </div>
              </td>
            </ng-container>

            <tr mat-header-row *matHeaderRowDef="displayedColumns; sticky: true"></tr>
            <tr mat-row *matRowDef="let row; columns: displayedColumns"></tr>
          </table>
        } @else if (!loading()) {
          <div class="empty-state">
            <mat-icon svgIcon="check-list"></mat-icon>
            <h3>{{ 'alerts.noRules' | translate }}</h3>
            <p>Create a rule to define when alerts should be triggered.</p>
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .rules-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        gap: var(--space-md);
      }

      .toolbar {
        display: flex;
        justify-content: flex-end;
        align-items: center;
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

      .rules-table {
        width: 100%;
        background: transparent;

        th.mat-mdc-header-cell {
          background: var(--card-bg-color);
          font-weight: 600;
          color: var(--text-muted);
          border-bottom: 1px solid var(--border-color);
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

        .rule-name {
          display: flex;
          flex-direction: column;
          gap: 4px;

          strong {
            color: var(--window-fg-color);
            font-size: var(--font-size-md);
          }

          .rule-meta {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
          }
        }

        .filter-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: center;
        }

        .cell-actions {
          display: flex;
          justify-content: flex-end;
          gap: 4px;
        }
      }

      .severity-badge {
        padding: 4px 8px;
        border-radius: 12px;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;

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

      .filter-badge {
        padding: 4px 8px;
        border-radius: 6px;
        font-size: 0.7rem;
        font-weight: 600;
        background: var(--bg-elevated);
        color: var(--text-muted);

        &.remote {
          background: rgba(var(--accent-color-rgb), 0.1);
          color: var(--accent-color);
        }
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
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertRulesComponent {
  private alertService = inject(AlertService);
  private modalService = inject(ModalService);
  private dialog = inject(MatDialog);

  rules = signal<AlertRule[]>([]);
  loading = signal(false);

  displayedColumns = ['name', 'filters', 'status', 'actions'];

  constructor() {
    this.refresh();
  }

  refresh() {
    this.loading.set(true);
    this.alertService
      .getAlertRules()
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe(rules => this.rules.set(rules));
  }

  createRule() {
    this.dialog
      .open(AlertRuleEditorComponent, { width: '600px', disableClose: true })
      .afterClosed()
      .subscribe(rule => {
        if (rule) this.alertService.saveAlertRule(rule).subscribe(() => this.refresh());
      });
  }

  editRule(rule: AlertRule) {
    this.dialog
      .open(AlertRuleEditorComponent, { width: '600px', disableClose: true, data: rule })
      .afterClosed()
      .subscribe(updated => {
        if (updated) this.alertService.saveAlertRule(updated).subscribe(() => this.refresh());
      });
  }

  deleteRule(rule: AlertRule) {
    this.modalService
      .openConfirm({
        title: 'common.delete',
        message: 'Are you sure you want to delete this alert rule?',
        confirmText: 'common.delete',
        cancelText: 'common.cancel',
      })
      .afterClosed()
      .subscribe(confirmed => {
        if (confirmed) this.alertService.deleteAlertRule(rule.id).subscribe(() => this.refresh());
      });
  }

  toggleRule(rule: AlertRule) {
    this.alertService.toggleAlertRule(rule.id, !rule.enabled).subscribe(() => this.refresh());
  }
}

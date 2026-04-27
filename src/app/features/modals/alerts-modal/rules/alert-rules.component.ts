import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TranslateModule } from '@ngx-translate/core';

import { AlertService, ModalService } from '@app/services';
import { AlertRule, AlertSeverity } from '@app/types';
import { SearchContainerComponent } from '@app/shared/components';

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
    SearchContainerComponent,
  ],
  template: `
    <div class="rules-container">
      <!-- Toolbar -->
      <div class="toolbar">
        <div class="spacer"></div>

        <button
          mat-icon-button
          (click)="searchVisible.set(!searchVisible())"
          [matTooltip]="'shared.search.toggle' | translate"
        >
          <mat-icon svgIcon="search"></mat-icon>
        </button>

        <button
          mat-flat-button
          color="primary"
          (click)="createRule()"
          [matTooltip]="'alerts.createRule' | translate"
        >
          <mat-icon svgIcon="plus"></mat-icon>
          {{ 'alerts.createRule' | translate }}
        </button>
      </div>

      <app-search-container
        [visible]="searchVisible()"
        [searchText]="alerts.rulesSearchTerm()"
        (searchTextChange)="onSearchChange($event)"
      ></app-search-container>

      <div class="rules-table-wrap" [class.loading]="alerts.isLoading()">
        @if (alerts.rules().length === 0 && !alerts.isLoading()) {
          <div class="empty-state">
            <mat-icon svgIcon="check-list"></mat-icon>
            <span>{{ 'alerts.noRules' | translate }}</span>
          </div>
        }

        @if (alerts.rules().length > 0) {
          <table mat-table [dataSource]="alerts.rules()">
            <!-- Severity Column -->
            <ng-container matColumnDef="severity">
              <th mat-header-cell *matHeaderCellDef>{{ 'alerts.severity' | translate }}</th>
              <td mat-cell *matCellDef="let rule">
                <div class="cell-content">
                  <span class="severity-badge" [class]="getSeverityClass(rule.severity_min)">
                    {{ 'alerts.severityLevels.' + rule.severity_min | translate }}
                  </span>
                </div>
              </td>
            </ng-container>

            <!-- Name Column -->
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.name' | translate }}</th>
              <td mat-cell *matCellDef="let rule">
                <div class="cell-content">
                  <span class="rule-name">{{ rule.name | translate }}</span>
                  @if (rule.last_fired) {
                    <span class="last-fired">
                      {{ 'alerts.lastFired' | translate }}:
                      {{ rule.last_fired | date: 'M/d/yy, h:mm:ss a' }}
                    </span>
                  }
                </div>
              </td>
            </ng-container>

            <!-- Filters Column -->
            <ng-container matColumnDef="filters">
              <th mat-header-cell *matHeaderCellDef>{{ 'alerts.rule.filters' | translate }}</th>
              <td mat-cell *matCellDef="let rule">
                <div class="cell-content filters-wrap">
                  <!-- Event Kinds -->
                  @if (rule.event_filter.length > 0) {
                    <div class="filter-group">
                      @for (kind of rule.event_filter; track kind) {
                        <span class="app-pill p-dim">
                          {{ 'alerts.events.' + kind | translate }}
                        </span>
                      }
                    </div>
                  } @else {
                    <span class="app-pill p-dim">{{ 'alerts.events.any' | translate }}</span>
                  }

                  <!-- Remotes -->
                  @if (rule.remote_filter.length > 0) {
                    <div class="filter-group">
                      @for (rem of rule.remote_filter; track rem) {
                        <span class="app-pill p-accent">
                          <mat-icon svgIcon="server"></mat-icon>
                          {{ rem }}
                        </span>
                      }
                    </div>
                  }
                </div>
              </td>
            </ng-container>

            <!-- Triggers Column -->
            <ng-container matColumnDef="triggers">
              <th mat-header-cell *matHeaderCellDef>{{ 'alerts.rule.actions' | translate }}</th>
              <td mat-cell *matCellDef="let rule">
                <div class="cell-content triggers-cell">
                  @for (actionId of rule.action_ids; track actionId) {
                    @if (alerts.actionsMap().get(actionId); as action) {
                      <mat-icon
                        [svgIcon]="alerts.getActionIcon(action.kind)"
                        [matTooltip]="action.name | translate"
                        class="trigger-icon"
                      ></mat-icon>
                    }
                  }
                  @if (rule.action_ids.length === 0) {
                    <span class="no-triggers">—</span>
                  }
                </div>
              </td>
            </ng-container>

            <!-- Status Column -->
            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.status' | translate }}</th>
              <td mat-cell *matCellDef="let rule">
                <div class="cell-content">
                  <mat-slide-toggle
                    [checked]="rule.enabled"
                    (change)="toggleRule(rule)"
                    color="primary"
                    [matTooltip]="
                      (rule.enabled ? 'task.status.enabled' : 'task.status.disabled') | translate
                    "
                  ></mat-slide-toggle>
                </div>
              </td>
            </ng-container>

            <!-- Actions Column -->
            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let rule">
                <div class="cell-content actions-wrap">
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
            <tr
              mat-row
              *matRowDef="let row; columns: displayedColumns"
              [class.disabled]="!row.enabled"
              [class]="getSeverityClass(row.severity_min)"
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

      .rules-container {
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      .toolbar {
        display: flex;
        align-items: center;
        gap: var(--space-xs);
        padding: var(--space-md);
        flex-shrink: 0;
      }

      .spacer {
        flex: 1;
      }

      /* ── Table Layout ────────────────────────────────── */
      .rules-table-wrap {
        flex: 1;
        overflow: auto;
        position: relative;
        border-top: 1px solid var(--border-color);

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

      /* ── Sticky Header Fix ───────────────────────────── */
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

      /* ── Cell base ───────────────────────────────────── */
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
        padding: 12px 0;
      }

      .mat-mdc-row {
        transition: background 0.12s ease;

        &:hover {
          background: var(--bg-elevated);
        }

        &.disabled {
          opacity: 0.6;
        }
      }

      /* ── Column Widths ────────────────────────────────── */
      .mat-column-severity {
        width: 88px;
      }
      .mat-column-name {
        min-width: 200px;
      }
      .mat-column-filters {
        min-width: 250px;
      }
      .mat-column-actions {
        width: 120px;
      }

      /* ── Severity Badge ──────────────────────────────── */
      .severity-badge {
        font-size: var(--font-size-sm);
        font-weight: 700;
        align-self: center;
        padding: 2px 6px;
        border-radius: var(--radius-xxs);
        white-space: nowrap;

        &.warn {
          color: var(--warn-color);
          background: rgba(var(--warn-color-rgb), var(--active-opacity));
        }
        &.orange {
          color: var(--orange);
          background: rgba(var(--orange-rgb), var(--active-opacity));
        }
        &.accent {
          color: var(--accent-color);
          background: rgba(var(--accent-color-rgb), var(--active-opacity));
        }
        &.yellow {
          color: var(--yellow);
          background: rgba(var(--yellow-rgb), var(--active-opacity));
        }
        &.primary {
          color: var(--primary-color);
          background: rgba(var(--primary-color-rgb), var(--active-opacity));
        }
        &.dim {
          color: var(--text-muted);
          background: var(--bg-elevated);
        }
      }

      /* ── Rule Info ───────────────────────────────────── */
      .rule-name {
        font-weight: 600;
        font-size: var(--font-size-md);
        color: var(--window-fg-color);
      }

      .last-fired {
        font-size: var(--font-size-xs);
        color: var(--text-muted);
      }

      /* ── Filters ─────────────────────────────────────── */
      .filters-wrap {
        gap: var(--space-xs);
      }

      .filter-group {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }

      .app-pill {
        font-size: var(--font-size-xs);
      }

      /* ── Triggers ────────────────────────────────────── */
      .triggers-cell {
        flex-direction: row;
        align-items: center;
        gap: var(--space-xs);
        flex-wrap: wrap;
      }

      .trigger-icon {
        width: 20px;
        height: 20px;
        font-size: 20px;
        color: var(--text-muted);
        opacity: 0.8;
        transition: opacity 0.1s ease;

        &:hover {
          opacity: 1;
          color: var(--primary-color);
        }
      }

      .no-triggers {
        color: var(--text-muted);
        font-size: var(--font-size-xs);
        opacity: 0.5;
      }

      /* ── Actions ─────────────────────────────────────── */
      .actions-wrap {
        flex-direction: row;
        align-items: center;
        gap: var(--space-xs);
      }

      /* ── Empty State ─────────────────────────────────── */
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 48px;
        gap: var(--space-md);
        color: var(--text-muted);

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
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertRulesComponent {
  public readonly alerts = inject(AlertService);
  private readonly modalService = inject(ModalService);

  searchVisible = signal(false);
  displayedColumns = ['severity', 'name', 'filters', 'triggers', 'status', 'actions'];

  onSearchChange(term: string): void {
    this.alerts.rulesSearchTerm.set(term);
  }

  getSeverityClass(severity: AlertSeverity): string {
    switch (severity) {
      case 'critical':
        return 'warn';
      case 'high':
        return 'orange';
      case 'average':
        return 'accent';
      case 'warning':
        return 'yellow';
      case 'info':
        return 'primary';
      default:
        return 'dim';
    }
  }

  createRule(): void {
    this.modalService
      .openAlertRuleEditor()
      .afterClosed()
      .subscribe(rule => {
        if (rule) this.alerts.saveAlertRule(rule).subscribe();
      });
  }

  editRule(rule: AlertRule): void {
    this.modalService
      .openAlertRuleEditor(rule)
      .afterClosed()
      .subscribe(updated => {
        if (updated) this.alerts.saveAlertRule(updated).subscribe();
      });
  }

  deleteRule(rule: AlertRule): void {
    this.modalService
      .openConfirm({
        title: 'common.delete',
        message: 'alerts.deleteRuleConfirm',
        confirmText: 'common.delete',
        cancelText: 'common.cancel',
      })
      .afterClosed()
      .subscribe(confirmed => {
        if (confirmed) this.alerts.deleteAlertRule(rule.id).subscribe();
      });
  }

  toggleRule(rule: AlertRule): void {
    this.alerts.toggleAlertRule(rule.id, !rule.enabled).subscribe();
  }
}

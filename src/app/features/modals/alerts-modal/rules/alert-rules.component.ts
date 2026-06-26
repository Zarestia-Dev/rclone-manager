import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe, NgClass } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TranslatePipe } from '@ngx-translate/core';

import { AlertService } from 'src/app/services/alerts/alert.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { AlertRule } from '@app/types';
import { SearchContainerComponent } from 'src/app/shared/components/search-container/search-container.component';
import { MatDialog } from '@angular/material/dialog';
import { AlertRuleEditorComponent } from './alert-rules-editor/alert-rule-editor.component';

@Component({
  selector: 'app-alert-rules',
  standalone: true,
  imports: [
    NgClass,
    DatePipe,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatSlideToggleModule,
    TranslatePipe,
    SearchContainerComponent,
    MatProgressSpinnerModule,
  ],
  template: `
    <div class="rules-container">
      <!-- Toolbar -->
      <div class="toolbar">
        <button
          mat-icon-button
          (click)="searchVisible.set(!searchVisible())"
          [matTooltip]="'shared.search.toggle' | translate"
        >
          <mat-icon svgIcon="search"></mat-icon>
        </button>

        <button mat-flat-button (click)="createRule()">
          <mat-icon svgIcon="plus"></mat-icon>
          {{ 'alerts.createRule' | translate }}
        </button>
      </div>

      <app-search-container
        [visible]="searchVisible()"
        [searchText]="alerts.rulesSearchTerm()"
        (searchTextChange)="onSearchChange($event)"
      ></app-search-container>

      <div class="table-wrap" [class.loading]="alerts.isLoading()">
        <!-- Loading -->
        @if (alerts.isLoading() && alerts.rules().length === 0) {
          <div class="empty-state">
            <mat-progress-spinner mode="indeterminate" diameter="32" strokeWidth="2">
            </mat-progress-spinner>
          </div>
        }

        <!-- Empty -->
        @if (!alerts.isLoading() && alerts.rules().length === 0) {
          <div class="empty-state">
            <mat-icon svgIcon="bell"></mat-icon>
            <span>{{ 'alerts.noRules' | translate }}</span>
            <p>{{ 'alerts.noRulesHint' | translate }}</p>
          </div>
        }

        <!-- Table -->
        @if (alerts.rules().length > 0) {
          <table mat-table [dataSource]="alerts.rules()">
            <!-- Severity -->
            <ng-container matColumnDef="severity">
              <th mat-header-cell *matHeaderCellDef>
                {{ 'alerts.severity' | translate }}
              </th>
              <td mat-cell *matCellDef="let rule">
                <span
                  class="severity-badge"
                  [style.color]="alerts.getSeverityStyle(rule.severity_min).color"
                  [style.background]="alerts.getSeverityStyle(rule.severity_min).bg"
                >
                  {{ 'alerts.severityLevels.' + rule.severity_min | translate }}
                </span>
              </td>
            </ng-container>

            <!-- Name -->
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef>
                {{ 'common.name' | translate }}
              </th>
              <td mat-cell *matCellDef="let rule">
                <span class="rule-name">{{ rule.name }}</span>
                <div class="rule-meta">
                  @if (rule.fire_count > 0) {
                    <span class="fire-count">
                      <mat-icon svgIcon="bolt"></mat-icon>
                      {{ rule.fire_count }}
                    </span>
                  }
                  @if (rule.last_fired) {
                    <span class="last-fired">
                      {{ 'alerts.lastFired' | translate }}
                      {{ rule.last_fired | date: 'short' }}
                    </span>
                  }
                </div>
              </td>
            </ng-container>

            <!-- Filters -->
            <ng-container matColumnDef="filters">
              <th mat-header-cell *matHeaderCellDef>
                {{ 'alerts.rule.filters' | translate }}
              </th>
              <td mat-cell *matCellDef="let rule">
                <div class="filters-cell">
                  @if (rule.event_filter.length === 0 && rule.remote_filter.length === 0) {
                    <span class="no-filters">{{ 'alerts.rule.allEvents' | translate }}</span>
                  }
                  @if (rule.event_filter.length > 0) {
                    <div class="filter-group">
                      @for (kind of rule.event_filter; track kind) {
                        <span class="app-pill p-dim">
                          {{ 'alerts.events.' + kind | translate }}
                        </span>
                      }
                    </div>
                  }
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

            <!-- Triggers / linked actions -->
            <ng-container matColumnDef="triggers">
              <th mat-header-cell *matHeaderCellDef>
                {{ 'alerts.rule.actions' | translate }}
              </th>
              <td mat-cell *matCellDef="let rule">
                <div class="triggers-cell">
                  @for (actionId of rule.action_ids; track actionId) {
                    @if (alerts.actionsMap().get(actionId); as action) {
                      <mat-icon
                        [svgIcon]="alerts.getActionIcon(action.kind)"
                        [matTooltip]="action.name"
                        class="trigger-icon"
                      ></mat-icon>
                    }
                  }
                  @if (rule.action_ids.length === 0) {
                    <span class="no-value">—</span>
                  }
                </div>
              </td>
            </ng-container>

            <!-- Status -->
            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef>
                {{ 'common.status' | translate }}
              </th>
              <td mat-cell *matCellDef="let rule">
                <mat-slide-toggle
                  [checked]="rule.enabled"
                  (change)="toggleRule(rule)"
                  [matTooltip]="
                    (rule.enabled ? 'automation.status.enabled' : 'automation.status.disabled')
                      | translate
                  "
                ></mat-slide-toggle>
              </td>
            </ng-container>

            <!-- Row actions -->
            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let rule">
                <div class="row-actions">
                  <button
                    mat-icon-button
                    (click)="editRule(rule)"
                    [matTooltip]="'common.edit' | translate"
                  >
                    <mat-icon svgIcon="pen"></mat-icon>
                  </button>
                  <button
                    mat-icon-button
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
              [ngClass]="{ 'row-disabled': !row.enabled }"
              [style.--row-accent]="alerts.getSeverityStyle(row.severity_min).color"
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

    .rules-container {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-xs);
      padding: var(--space-md);
      flex-shrink: 0;
    }

    .table-wrap {
      flex: 1;
      overflow: auto;
      position: relative;
      border-top: 1px solid var(--border-color);
      transition: opacity 0.2s ease;

      &.loading {
        opacity: 0.5;
        pointer-events: none;
      }

      table {
        width: 100%;
        min-width: 720px;
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

      vertical-align: middle;
    }

    .mat-mdc-row {
      border-left: 3px solid var(--row-accent, transparent);
      transition:
        background 0.1s ease,
        border-color 0.1s ease;

      &:hover {
        background: var(--hover-bg-color);
      }
      &.row-disabled {
        opacity: 0.5;
      }
    }

    .mat-column-severity {
      width: 96px;
    }
    .mat-column-name {
      min-width: 180px;
    }
    .mat-column-filters {
      min-width: 200px;
    }
    .mat-column-triggers {
      width: 120px;
    }
    .mat-column-status {
      width: 80px;
    }
    .mat-column-actions {
      width: 96px;
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

    .rule-name {
      font-weight: 600;
      font-size: var(--font-size-md);
      color: var(--window-fg-color);
      line-height: 1.3;
    }

    .rule-meta {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      margin-top: 2px;
    }

    .fire-count {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      font-size: var(--font-size-xs);
      color: var(--dim-color);
      font-weight: 600;

      mat-icon {
        width: 12px;
        height: 12px;
        font-size: 12px;
        color: var(--orange);
      }
    }

    .last-fired {
      font-size: var(--font-size-xs);
      color: var(--dim-color);
    }

    .filters-cell {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      padding: var(--space-xs) 0;
    }

    .filter-group {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .no-filters {
      font-size: var(--font-size-xs);
      color: var(--dim-color);
      font-style: italic;
      opacity: 0.7;
    }

    .triggers-cell {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-xs);
      padding: var(--space-xs) 0;
    }

    .trigger-icon {
      width: 18px;
      height: 18px;
      font-size: 18px;
      color: var(--dim-color);
      opacity: 0.7;
      transition:
        opacity 0.1s ease,
        color 0.1s ease;
      cursor: default;

      &:hover {
        opacity: 1;
        color: var(--primary-color);
      }
    }

    .no-value {
      color: var(--dim-color);
      font-size: var(--font-size-xs);
      opacity: 0.5;
    }

    .row-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-xxs);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertRulesComponent {
  public readonly alerts = inject(AlertService);
  private readonly dialog = inject(MatDialog);
  private readonly notificationService = inject(NotificationService);

  searchVisible = signal(false);
  displayedColumns = ['severity', 'name', 'filters', 'triggers', 'status', 'actions'];

  onSearchChange(term: string): void {
    this.alerts.rulesSearchTerm.set(term);
  }

  createRule(): void {
    this.dialog
      .open(AlertRuleEditorComponent, {
        width: '600px',
        disableClose: true,
        data: { ruleId: undefined },
      })
      .afterClosed()
      .subscribe(async rule => {
        if (rule) await this.alerts.saveAlertRule(rule);
      });
  }

  editRule(rule: AlertRule): void {
    this.dialog
      .open(AlertRuleEditorComponent, {
        width: '600px',
        disableClose: true,
        data: { ruleId: rule.id },
      })
      .afterClosed()
      .subscribe(async updated => {
        if (updated) await this.alerts.saveAlertRule(updated);
      });
  }

  async deleteRule(rule: AlertRule): Promise<void> {
    const confirmed = await this.notificationService.confirmModal(
      'common.delete',
      'alerts.deleteRuleConfirm',
      'common.delete',
      'common.cancel'
    );
    if (confirmed) {
      await this.alerts.deleteAlertRule(rule.id);
    }
  }

  async toggleRule(rule: AlertRule): Promise<void> {
    await this.alerts.toggleAlertRule(rule.id, !rule.enabled);
  }
}

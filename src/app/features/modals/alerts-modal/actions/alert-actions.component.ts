import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

import { AlertService, ModalService, NotificationService } from '@app/services';
import { AlertAction } from '@app/types';
import { SearchContainerComponent } from '@app/shared/components';

@Component({
  selector: 'app-alert-actions',
  standalone: true,
  imports: [
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatSlideToggleModule,
    MatProgressSpinnerModule,
    TranslateModule,
    SearchContainerComponent,
  ],
  template: `
    <div class="actions-container">
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
          (click)="createAction()"
          [matTooltip]="'alerts.createAction' | translate"
        >
          <mat-icon svgIcon="plus"></mat-icon>
          {{ 'alerts.createAction' | translate }}
        </button>
      </div>

      <app-search-container
        [visible]="searchVisible()"
        [searchText]="alerts.actionsSearchTerm()"
        (searchTextChange)="onSearchChange($event)"
      ></app-search-container>

      <div class="actions-table-wrap" [class.loading]="alerts.isLoading()">
        @if (alerts.actions().length === 0 && !alerts.isLoading()) {
          <div class="empty-state">
            <mat-icon svgIcon="bolt"></mat-icon>
            <span>{{ 'alerts.noActions' | translate }}</span>
          </div>
        }

        @if (alerts.actions().length > 0) {
          <table mat-table [dataSource]="alerts.actions()">
            <!-- Kind Column -->
            <ng-container matColumnDef="kind">
              <th mat-header-cell *matHeaderCellDef>{{ 'alerts.action.kind' | translate }}</th>
              <td mat-cell *matCellDef="let action">
                <div class="cell-content">
                  <span class="app-pill p-dim action-kind-pill">
                    <mat-icon [svgIcon]="alerts.getActionIcon(action.kind)"></mat-icon>
                    {{ 'alerts.action.' + action.kind | translate }}
                  </span>
                </div>
              </td>
            </ng-container>

            <!-- Name Column -->
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.name' | translate }}</th>
              <td mat-cell *matCellDef="let action">
                <div class="cell-content">
                  <span class="action-name">{{ action.name | translate }}</span>
                </div>
              </td>
            </ng-container>

            <!-- Status Column -->
            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.status' | translate }}</th>
              <td mat-cell *matCellDef="let action">
                <div class="cell-content">
                  <mat-slide-toggle
                    [checked]="action.enabled"
                    (change)="toggleAction(action)"
                    color="primary"
                    [matTooltip]="
                      (action.enabled ? 'task.status.enabled' : 'task.status.disabled') | translate
                    "
                  ></mat-slide-toggle>
                </div>
              </td>
            </ng-container>

            <!-- Actions Column -->
            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let action">
                <div class="cell-content actions-wrap">
                  <button
                    mat-icon-button
                    (click)="testAction(action)"
                    [matTooltip]="'alerts.testAction' | translate"
                    [disabled]="alerts.testingActionIds().has(action.id)"
                  >
                    @if (alerts.testingActionIds().has(action.id)) {
                      <mat-progress-spinner
                        mode="indeterminate"
                        diameter="24"
                        strokeWidth="2"
                      ></mat-progress-spinner>
                    } @else {
                      <mat-icon svgIcon="play"></mat-icon>
                    }
                  </button>
                  <button
                    mat-icon-button
                    (click)="editAction(action)"
                    [matTooltip]="'common.edit' | translate"
                  >
                    <mat-icon svgIcon="pen"></mat-icon>
                  </button>
                  <button
                    mat-icon-button
                    color="warn"
                    (click)="deleteAction(action)"
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

      .actions-container {
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
      .actions-table-wrap {
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
          min-width: 700px;
          border-collapse: separate;
          border-spacing: 0;
        }
      }

      .mat-mdc-header-row {
        height: 48px;
      }

      /* ── Sticky Header ───────────────────────────────── */
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
      .mat-column-kind {
        width: 150px;
      }
      .mat-column-name {
        min-width: 200px;
      }
      .mat-column-status {
        width: 100px;
      }
      .mat-column-actions {
        width: 150px;
      }

      /* ── Kind Pill ───────────────────────────────────── */
      .action-kind-pill {
        display: flex;
        align-items: center;
        gap: 4px;
        width: fit-content;
        font-weight: 600;

        mat-icon {
          width: 14px;
          height: 14px;
          font-size: 14px;
        }
      }

      .action-name {
        font-weight: 600;
        font-size: var(--font-size-md);
        color: var(--window-fg-color);
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
export class AlertActionsComponent {
  public readonly alerts = inject(AlertService);
  private readonly modalService = inject(ModalService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  searchVisible = signal(false);
  displayedColumns = ['kind', 'name', 'status', 'actions'];

  onSearchChange(term: string): void {
    this.alerts.actionsSearchTerm.set(term);
  }

  createAction(): void {
    this.modalService
      .openAlertActionEditor()
      .afterClosed()
      .subscribe(action => {
        if (action) this.alerts.saveAlertAction(action).subscribe();
      });
  }

  editAction(action: AlertAction): void {
    this.modalService
      .openAlertActionEditor(action)
      .afterClosed()
      .subscribe(updated => {
        if (updated) this.alerts.saveAlertAction(updated).subscribe();
      });
  }

  deleteAction(action: AlertAction): void {
    this.modalService
      .openConfirm({
        title: 'common.delete',
        message: 'alerts.deleteActionConfirm',
        confirmText: 'common.delete',
        cancelText: 'common.cancel',
      })
      .afterClosed()
      .subscribe(confirmed => {
        if (confirmed) this.alerts.deleteAlertAction(action.id).subscribe();
      });
  }

  toggleAction(action: AlertAction): void {
    const updated = { ...action, enabled: !action.enabled };
    this.alerts.saveAlertAction(updated).subscribe();
  }

  testAction(action: AlertAction): void {
    this.alerts.testAlertAction(action.id).subscribe({
      next: success => {
        if (success) {
          this.notifications.showSuccess(this.translate.instant('alerts.testActionSuccess'));
        } else {
          this.notifications.showError(
            this.translate.instant('alerts.testActionFailed', { error: 'Unknown failure' })
          );
        }
      },
      error: err => {
        this.notifications.showError(
          this.translate.instant('alerts.testActionError', { error: err })
        );
        console.error('Test failed', err);
      },
    });
  }
}

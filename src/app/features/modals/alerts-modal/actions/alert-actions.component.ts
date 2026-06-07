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
        <button
          mat-icon-button
          (click)="searchVisible.set(!searchVisible())"
          [matTooltip]="'shared.search.toggle' | translate"
        >
          <mat-icon svgIcon="search"></mat-icon>
        </button>

        <button mat-flat-button (click)="createAction()">
          <mat-icon svgIcon="plus"></mat-icon>
          {{ 'alerts.createAction' | translate }}
        </button>
      </div>

      <app-search-container
        [visible]="searchVisible()"
        [searchText]="alerts.actionsSearchTerm()"
        (searchTextChange)="onSearchChange($event)"
      ></app-search-container>

      <div class="table-wrap" [class.loading]="alerts.isLoading()">
        <!-- Loading -->
        @if (alerts.isLoading() && alerts.actions().length === 0) {
          <div class="empty-state">
            <mat-progress-spinner mode="indeterminate" diameter="24"> </mat-progress-spinner>
          </div>
        }

        <!-- Empty -->
        @if (!alerts.isLoading() && alerts.actions().length === 0) {
          <div class="empty-state">
            <mat-icon svgIcon="bolt"></mat-icon>
            <span>{{ 'alerts.noActions' | translate }}</span>
            <p>{{ 'alerts.noActionsHint' | translate }}</p>
          </div>
        }

        <!-- Table -->
        @if (alerts.actions().length > 0) {
          <table mat-table [dataSource]="alerts.actions()">
            <!-- Kind -->
            <ng-container matColumnDef="kind">
              <th mat-header-cell *matHeaderCellDef>
                {{ 'alerts.action.kind' | translate }}
              </th>
              <td mat-cell *matCellDef="let action">
                <span class="app-pill p-dim kind-pill">
                  <mat-icon [svgIcon]="alerts.getActionIcon(action.kind)"></mat-icon>
                  {{ 'alerts.action.' + action.kind | translate }}
                </span>
              </td>
            </ng-container>

            <!-- Name -->
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef>
                {{ 'common.name' | translate }}
              </th>
              <td mat-cell *matCellDef="let action">
                <!-- ⚠ No | translate here — action.name is a user string, not an i18n key -->
                <span class="action-name">{{ action.name }}</span>
              </td>
            </ng-container>

            <!-- Status -->
            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef>
                {{ 'common.status' | translate }}
              </th>
              <td mat-cell *matCellDef="let action">
                <mat-slide-toggle
                  [checked]="action.enabled"
                  (change)="toggleAction(action)"
                  [matTooltip]="
                    (action.enabled ? 'automation.status.enabled' : 'automation.status.disabled')
                      | translate
                  "
                ></mat-slide-toggle>
              </td>
            </ng-container>

            <!-- Row actions -->
            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let action">
                <div class="row-actions">
                  <!-- Test -->
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
                      ></mat-progress-spinner>
                    } @else {
                      <mat-icon svgIcon="play"></mat-icon>
                    }
                  </button>

                  <!-- Edit -->
                  <button
                    mat-icon-button
                    (click)="editAction(action)"
                    [matTooltip]="'common.edit' | translate"
                  >
                    <mat-icon svgIcon="pen"></mat-icon>
                  </button>

                  <!-- Delete -->
                  <button
                    mat-icon-button
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
              [class.row-disabled]="!row.enabled"
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

    .actions-container {
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
        min-width: 640px;
      }
    }

    .mat-mdc-header-row {
      height: 44px;
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
      padding: var(--space-sm) !important;
      border-bottom: 1px solid var(--border-color) !important;
      border-right: 1px solid var(--border-color);
      vertical-align: middle;
    }

    .mat-mdc-row {
      transition: background 0.1s ease;

      &:hover {
        background: var(--hover-bg-color);
      }
      &.row-disabled {
        opacity: 0.5;
      }
    }

    .mat-column-kind {
      width: 160px;
    }
    .mat-column-name {
      min-width: 180px;
    }
    .mat-column-status {
      width: 90px;
    }
    .mat-column-actions {
      width: 136px;
    }

    .kind-pill {
      width: fit-content;

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

    .row-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-xxs);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertActionsComponent {
  public readonly alerts = inject(AlertService);
  private readonly modalService = inject(ModalService);
  private readonly notificationService = inject(NotificationService);
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
      .subscribe(async action => {
        if (action) await this.alerts.saveAlertAction(action);
      });
  }

  editAction(action: AlertAction): void {
    this.modalService
      .openAlertActionEditor(action.id)
      .afterClosed()
      .subscribe(async updated => {
        if (updated) await this.alerts.saveAlertAction(updated);
      });
  }

  async deleteAction(action: AlertAction): Promise<void> {
    const confirmed = await this.notificationService.confirmModal(
      'common.delete',
      'alerts.deleteActionConfirm',
      'common.delete',
      'common.cancel'
    );
    if (confirmed) {
      await this.alerts.deleteAlertAction(action.id);
    }
  }

  async toggleAction(action: AlertAction): Promise<void> {
    await this.alerts.saveAlertAction({ ...action, enabled: !action.enabled });
  }

  async testAction(action: AlertAction): Promise<void> {
    try {
      const success = await this.alerts.testAlertAction(action.id);
      if (success) {
        this.notificationService.showSuccess(this.translate.instant('alerts.testActionSuccess'));
      } else {
        this.notificationService.showError(
          this.translate.instant('alerts.testActionFailed', { error: 'Unknown failure' })
        );
      }
    } catch (err) {
      this.notificationService.showError(
        this.translate.instant('alerts.testActionError', { error: err })
      );
      console.error('Test failed', err);
    }
  }
}

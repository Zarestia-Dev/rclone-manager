import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatDialog } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import { finalize } from 'rxjs';

import { AlertService, ModalService } from '@app/services';
import { AlertAction } from '@app/types';
import { AlertActionEditorComponent } from './alert-action-editor.component';

@Component({
  selector: 'app-alert-actions',
  standalone: true,
  imports: [
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatSlideToggleModule,
    TranslateModule,
  ],
  template: `
    <div class="actions-container">
      <div class="toolbar">
        <button mat-flat-button color="primary" (click)="createAction()">
          <mat-icon svgIcon="plus"></mat-icon>
          {{ 'alerts.createAction' | translate }}
        </button>
      </div>

      <div class="table-wrapper boxed-list" [class.loading]="loading()">
        @if (actions().length > 0) {
          <table mat-table [dataSource]="actions()" class="actions-table">
            <ng-container matColumnDef="name">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.name' | translate }}</th>
              <td mat-cell *matCellDef="let action">
                <div class="action-name">
                  <strong>{{ action.name }}</strong>
                  <span class="kind-tag">{{ 'alerts.action.' + action.kind | translate }}</span>
                </div>
              </td>
            </ng-container>

            <ng-container matColumnDef="status">
              <th mat-header-cell *matHeaderCellDef>{{ 'common.status' | translate }}</th>
              <td mat-cell *matCellDef="let action">
                <mat-slide-toggle
                  [checked]="action.enabled"
                  (change)="toggleAction(action)"
                ></mat-slide-toggle>
              </td>
            </ng-container>

            <ng-container matColumnDef="actions">
              <th mat-header-cell *matHeaderCellDef></th>
              <td mat-cell *matCellDef="let action">
                <div class="cell-actions">
                  <button
                    mat-icon-button
                    (click)="testAction(action)"
                    [matTooltip]="'alerts.testAction' | translate"
                  >
                    <mat-icon svgIcon="play"></mat-icon>
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
            <tr mat-row *matRowDef="let row; columns: displayedColumns"></tr>
          </table>
        } @else if (!loading()) {
          <div class="empty-state">
            <mat-icon svgIcon="bolt"></mat-icon>
            <h3>{{ 'alerts.noActions' | translate }}</h3>
            <p>Create actions (Webhooks, Scripts, etc.) to trigger when alerts fire.</p>
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .actions-container {
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

      .actions-table {
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

        .action-name {
          display: flex;
          flex-direction: column;
          gap: 4px;

          strong {
            color: var(--window-fg-color);
            font-size: var(--font-size-md);
          }

          .kind-tag {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
        }

        .cell-actions {
          display: flex;
          justify-content: flex-end;
          gap: 4px;
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
export class AlertActionsComponent {
  private alertService = inject(AlertService);
  private modalService = inject(ModalService);
  private dialog = inject(MatDialog);

  actions = signal<AlertAction[]>([]);
  loading = signal(false);

  displayedColumns = ['name', 'status', 'actions'];

  constructor() {
    this.refresh();
  }

  refresh() {
    this.loading.set(true);
    this.alertService
      .getAlertActions()
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe(actions => this.actions.set(actions));
  }

  createAction() {
    this.dialog
      .open(AlertActionEditorComponent, { width: '600px', disableClose: true })
      .afterClosed()
      .subscribe(action => {
        if (action) this.alertService.saveAlertAction(action).subscribe(() => this.refresh());
      });
  }

  editAction(action: AlertAction) {
    this.dialog
      .open(AlertActionEditorComponent, { width: '600px', disableClose: true, data: action })
      .afterClosed()
      .subscribe(updated => {
        if (updated) this.alertService.saveAlertAction(updated).subscribe(() => this.refresh());
      });
  }

  deleteAction(action: AlertAction) {
    this.modalService
      .openConfirm({
        title: 'common.delete',
        message: 'Are you sure you want to delete this action?',
        confirmText: 'common.delete',
        cancelText: 'common.cancel',
      })
      .afterClosed()
      .subscribe(confirmed => {
        if (confirmed)
          this.alertService.deleteAlertAction(action.id).subscribe(() => this.refresh());
      });
  }

  toggleAction(action: AlertAction) {
    const updated = { ...action, enabled: !action.enabled };
    this.alertService.saveAlertAction(updated).subscribe(() => this.refresh());
  }

  testAction(action: AlertAction) {
    this.alertService.testAlertAction(action.id).subscribe({
      next: success => {
        if (success) console.log('Test success');
      },
      error: err => console.error('Test failed', err),
    });
  }
}

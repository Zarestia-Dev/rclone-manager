import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';

import { AlertHistoryComponent } from './history/alert-history.component';
import { AlertRulesComponent } from './rules/alert-rules.component';
import { AlertActionsComponent } from './actions/alert-actions.component';

@Component({
  selector: 'app-alerts-modal',
  standalone: true,
  imports: [
    CommonModule,
    MatTabsModule,
    MatButtonModule,
    MatIconModule,
    MatDialogModule,
    TranslateModule,
    AlertHistoryComponent,
    AlertRulesComponent,
    AlertActionsComponent,
  ],
  template: `
    <div class="modal-container">
      <header class="modal-header">
        <button>
          <mat-icon svgIcon="bell"></mat-icon>
        </button>
        <p>{{ 'alerts.title' | translate }}</p>
        <button mat-icon-button (click)="close()" [attr.aria-label]="'common.close' | translate">
          <mat-icon svgIcon="circle-xmark"></mat-icon>
        </button>
      </header>

      <mat-tab-group class="alerts-tabs" [animationDuration]="'200ms'">
        <mat-tab>
          <ng-template mat-tab-label>
            <mat-icon svgIcon="clock-rotate-left"></mat-icon>
            <span>{{ 'alerts.history' | translate }}</span>
          </ng-template>
          <div class="tab-content">
            <app-alert-history></app-alert-history>
          </div>
        </mat-tab>

        <mat-tab>
          <ng-template mat-tab-label>
            <mat-icon svgIcon="check-list"></mat-icon>
            <span>{{ 'alerts.rules' | translate }}</span>
          </ng-template>
          <div class="tab-content">
            <app-alert-rules></app-alert-rules>
          </div>
        </mat-tab>

        <mat-tab>
          <ng-template mat-tab-label>
            <mat-icon svgIcon="bolt"></mat-icon>
            <span>{{ 'alerts.actions' | translate }}</span>
          </ng-template>
          <div class="tab-content">
            <app-alert-actions></app-alert-actions>
          </div>
        </mat-tab>
      </mat-tab-group>
    </div>
  `,
  styles: [
    `
      .modal-header {
        padding: var(--space-xs);
        gap: var(--space-xs);
        display: flex;
        justify-content: space-between;
        align-items: center;
        position: relative;
        flex-shrink: 0;

        &.scrolled {
          box-shadow: var(--shadow-gnome);
        }

        &.scrolled p {
          opacity: 1 !important;
        }

        .header-title-ghost {
          opacity: 0;
        }

        .text-nowrap {
          text-wrap: nowrap;
        }

        p {
          font-size: var(--font-size-md);
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          margin: 0;
        }

        @media (max-width: 768px) {
          font-size: var(--font-size-base);
        }

        @media (max-width: 480px) {
          font-size: var(--font-size-sm);
        }
      }

      .modal-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden; /* Prevent the entire modal from scrolling */
        background: var(--window-bg-color);
      }

      .alerts-tabs {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0; /* Crucial for nested flexbox overflow */

        ::ng-deep .mat-mdc-tab-body-wrapper {
          flex: 1;
          min-height: 0; /* Crucial for nested flexbox overflow */
        }

        .tab-content {
          height: 100%;
          overflow-y: auto;
          padding: var(--space-md);
          box-sizing: border-box;
        }
      }

      ::ng-deep .mat-mdc-tab-label-content {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-weight: 500;
        letter-spacing: 0.2px;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertsModalComponent {
  private dialogRef = inject(MatDialogRef<AlertsModalComponent>);

  close(): void {
    this.dialogRef.close();
  }
}

import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialogRef } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';

import { AlertService } from 'src/app/services/alerts/alert.service';
import { AlertHistoryComponent } from './history/alert-history.component';
import { AlertRulesComponent } from './rules/alert-rules.component';
import { AlertActionsComponent } from './actions/alert-actions.component';

@Component({
  selector: 'app-alerts-modal',
  standalone: true,
  imports: [
    MatTabsModule,
    MatButtonModule,
    MatIconModule,
    TranslateModule,
    AlertHistoryComponent,
    AlertRulesComponent,
    AlertActionsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header data-tauri-drag-region>
      <button>
        <mat-icon svgIcon="bell"></mat-icon>
      </button>
      <p class="header-title">{{ 'alerts.title' | translate }}</p>
      <button mat-icon-button (click)="close()" [attr.aria-label]="'common.close' | translate">
        <mat-icon svgIcon="circle-xmark"></mat-icon>
      </button>
    </header>

    <mat-tab-group>
      <mat-tab>
        <ng-template mat-tab-label>
          <mat-icon svgIcon="bell" class="tab-icon"></mat-icon>
          <span>{{ 'alerts.history' | translate }}</span>
          @if (alerts.unacknowledged() > 0) {
            <span class="tab-badge">{{ alerts.unacknowledged() }}</span>
          }
        </ng-template>
        <div class="tab-content">
          <app-alert-history></app-alert-history>
        </div>
      </mat-tab>

      <!-- Rules -->
      <mat-tab>
        <ng-template mat-tab-label>
          <mat-icon svgIcon="filter" class="tab-icon"></mat-icon>
          <span>{{ 'alerts.rules' | translate }}</span>
          @if (alerts.rules().length > 0) {
            <span class="tab-count">{{ alerts.rules().length }}</span>
          }
        </ng-template>
        <div class="tab-content">
          <app-alert-rules></app-alert-rules>
        </div>
      </mat-tab>

      <!-- Actions -->
      <mat-tab>
        <ng-template mat-tab-label>
          <mat-icon svgIcon="bolt" class="tab-icon"></mat-icon>
          <span>{{ 'alerts.actions' | translate }}</span>
          @if (alerts.actions().length > 0) {
            <span class="tab-count">{{ alerts.actions().length }}</span>
          }
        </ng-template>
        <div class="tab-content">
          <app-alert-actions></app-alert-actions>
        </div>
      </mat-tab>
    </mat-tab-group>
  `,
  styles: `
    .tab-content {
      height: 100%;
      overflow: hidden;
    }

    .tab-icon {
      width: var(--icon-size-sm);
      height: var(--icon-size-sm);
      font-size: var(--icon-size-sm);
      margin-right: var(--space-xs);
      opacity: 0.7;
    }

    .tab-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: var(--space-xs);
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 9px;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      background: var(--warn-color);
      color: #fff;
    }

    .tab-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: var(--space-xs);
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 9px;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      background: rgba(var(--window-fg-color-rgb), 0.1);
      color: var(--dim-color);
    }
  `,
  styleUrl: '../../../styles/_shared-modal.scss',
})
export class AlertsModalComponent {
  private readonly dialogRef = inject(MatDialogRef<AlertsModalComponent>);

  readonly alerts = inject(AlertService);

  close(): void {
    this.dialogRef.close();
  }
}

import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
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
      <header class="modal-header" data-tauri-drag-region>
        <button>
          <mat-icon svgIcon="bell"></mat-icon>
        </button>
        <p class="header-title">{{ 'alerts.title' | translate }}</p>
        <button
          mat-icon-button
          (click)="close()"
          [attr.aria-label]="'common.close' | translate"
          class="close-btn"
        >
          <mat-icon svgIcon="circle-xmark"></mat-icon>
        </button>
      </header>

      <mat-tab-group class="alerts-tabs" [animationDuration]="'200ms'">
        <mat-tab>
          <ng-template mat-tab-label>
            <span class="tab-label">{{ 'alerts.history' | translate }}</span>
          </ng-template>
          <div class="tab-content">
            <app-alert-history></app-alert-history>
          </div>
        </mat-tab>

        <mat-tab>
          <ng-template mat-tab-label>
            <span class="tab-label">{{ 'alerts.rules' | translate }}</span>
          </ng-template>
          <div class="tab-content">
            <app-alert-rules></app-alert-rules>
          </div>
        </mat-tab>

        <mat-tab>
          <ng-template mat-tab-label>
            <span class="tab-label">{{ 'alerts.actions' | translate }}</span>
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
      .modal-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
        background: var(--window-bg-color);
      }

      .alerts-tabs {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;

        .tab-content {
          height: 100%;
          overflow-y: auto;
        }
      }
    `,
  ],
  styleUrl: '../../../styles/_shared-modal.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertsModalComponent {
  private dialogRef = inject(MatDialogRef<AlertsModalComponent>);

  close(): void {
    this.dialogRef.close();
  }
}

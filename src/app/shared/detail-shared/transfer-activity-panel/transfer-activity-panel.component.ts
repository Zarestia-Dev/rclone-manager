import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';

import { ActiveTransfersTableComponent } from './active-transfers-table.component';
import { CompletedTransfersTableComponent } from './completed-transfers-table.component';
import { TransferActivityPanelConfig } from '../../types';

@Component({
  selector: 'app-transfer-activity-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatIconModule,
    MatTabsModule,
    MatButtonModule,
    MatTooltipModule,
    TranslateModule,
    ActiveTransfersTableComponent,
    CompletedTransfersTableComponent,
  ],
  template: `
    <mat-card class="detail-panel transfer-activity-panel">
      <mat-card-header class="panel-header">
        <mat-card-title>
          <mat-icon svgIcon="download" class="primary-icon"></mat-icon>
          <span>{{ 'shared.transferActivity.title' | translate }}</span>
          @if (config().showHistory) {
            <button
              mat-icon-button
              (click)="resetStats.emit()"
              [matTooltip]="'shared.transferActivity.resetStats' | translate"
            >
              <mat-icon svgIcon="broom" class="primary-icon"></mat-icon>
            </button>
          }
        </mat-card-title>
      </mat-card-header>

      <mat-card-content class="panel-content">
        @if (config().showHistory && config().completedTransfers.length > 0) {
          <mat-tab-group>
            <mat-tab
              [label]="
                'shared.transferActivity.tabs.active'
                  | translate: { count: config().activeTransfers.length }
              "
            >
              <ng-template matTabContent>
                <app-active-transfers-table
                  [transfers]="config().activeTransfers"
                ></app-active-transfers-table>
              </ng-template>
            </mat-tab>
            <mat-tab
              [label]="
                'shared.transferActivity.tabs.recent'
                  | translate: { count: config().completedTransfers.length }
              "
            >
              <ng-template matTabContent>
                <app-completed-transfers-table
                  [transfers]="config().completedTransfers"
                ></app-completed-transfers-table>
              </ng-template>
            </mat-tab>
          </mat-tab-group>
        } @else {
          <div class="single-view-content">
            <app-active-transfers-table
              [transfers]="config().activeTransfers"
            ></app-active-transfers-table>
          </div>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .transfer-activity-panel {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      .panel-content {
        padding: 0;
        overflow: hidden;
      }
      .single-view-content {
        max-height: 40vh;
        overflow: hidden;
      }
      .primary-icon {
        color: var(--mat-sys-primary);
      }
    }
  `,
})
export class TransferActivityPanelComponent {
  readonly config = input.required<TransferActivityPanelConfig>();
  readonly resetStats = output<void>();
}

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
        <mat-card-title class="panel-title-content">
          <mat-icon svgIcon="download" style="color: var(--mat-sys-primary);"></mat-icon>
          <span>{{ 'shared.transferActivity.title' | translate }}</span>
          @if (config().showHistory) {
            <button
              mat-icon-button
              (click)="resetStats.emit()"
              [matTooltip]="'shared.transferActivity.resetStats' | translate"
            >
              <mat-icon svgIcon="broom" style="color: var(--mat-sys-primary);"></mat-icon>
            </button>
          }
        </mat-card-title>
      </mat-card-header>

      <mat-card-content class="panel-content">
        @if (config().showHistory && config().completedTransfers.length > 0) {
          <mat-tab-group>
            <mat-tab>
              <ng-template mat-tab-label>
                <span>{{
                  'shared.transferActivity.tabs.active'
                    | translate: { count: config().activeTransfers.length }
                }}</span>
              </ng-template>
              <ng-template matTabContent>
                <app-active-transfers-table
                  [transfers]="config().activeTransfers"
                ></app-active-transfers-table>
              </ng-template>
            </mat-tab>
            <mat-tab>
              <ng-template mat-tab-label>
                <span>{{
                  'shared.transferActivity.tabs.recent'
                    | translate: { count: config().completedTransfers.length }
                }}</span>
              </ng-template>
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
  styleUrls: ['./transfer-activity-panel.component.scss'],
})
export class TransferActivityPanelComponent {
  readonly config = input.required<TransferActivityPanelConfig>();
  readonly resetStats = output<void>();
}

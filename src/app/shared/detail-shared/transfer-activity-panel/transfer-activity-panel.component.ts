import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatChipsModule } from '@angular/material/chips';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';

import { ActiveTransfersTableComponent } from './active-transfers-table.component';
import { CompletedTransfersTableComponent } from './completed-transfers-table.component';
import { TransferActivityPanelConfig } from '../../types';

@Component({
  selector: 'app-transfer-activity-panel',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatTabsModule,
    MatChipsModule,
    MatButtonModule,
    MatTooltipModule,
    TranslateModule,
    ActiveTransfersTableComponent,
    CompletedTransfersTableComponent,
  ],
  template: `
    <mat-card class="detail-panel transfer-activity-panel" [ngClass]="config().operationClass">
      <mat-card-header class="panel-header">
        <mat-card-title class="panel-title-content">
          <mat-icon svgIcon="download" class="panel-icon"></mat-icon>
          <span>{{ 'shared.transferActivity.title' | translate }}</span>
          <div class="transfer-summary">
            <mat-chip [class]="'summary-chip active ' + config().operationColor">
              <span class="chip-label">{{ 'shared.transferActivity.active' | translate }}</span>
              <span class="chip-value">{{ config().activeTransfers.length }}</span>
            </mat-chip>
            @if (config().showHistory) {
              <mat-chip [class]="'summary-chip completed ' + config().operationColor">
                <span class="chip-label">{{ 'shared.transferActivity.recent' | translate }}</span>
                <span class="chip-value">{{ config().completedTransfers.length }}</span>
              </mat-chip>
            }
          </div>
          @if (config().showHistory) {
            <button
              mat-icon-button
              class="warn"
              (click)="resetStats.emit()"
              [matTooltip]="'shared.transferActivity.resetStats' | translate"
            >
              <mat-icon svgIcon="broom"></mat-icon>
            </button>
          }
        </mat-card-title>
      </mat-card-header>

      <mat-card-content class="panel-content">
        @if (config().showHistory && config().completedTransfers.length > 0) {
          <mat-tab-group class="transfer-tabs" animationDuration="200ms">
            <mat-tab>
              <ng-template mat-tab-label>
                <span>{{
                  'shared.transferActivity.tabs.active'
                    | translate: { count: config().activeTransfers.length }
                }}</span>
              </ng-template>
              <div class="tab-content">
                <app-active-transfers-table
                  [transfers]="config().activeTransfers"
                  [operationClass]="config().operationClass"
                ></app-active-transfers-table>
              </div>
            </mat-tab>
            <mat-tab>
              <ng-template mat-tab-label>
                <span>{{
                  'shared.transferActivity.tabs.recent'
                    | translate: { count: config().completedTransfers.length }
                }}</span>
              </ng-template>
              <div class="tab-content">
                <app-completed-transfers-table
                  [transfers]="config().completedTransfers"
                  [operationClass]="config().operationClass"
                ></app-completed-transfers-table>
              </div>
            </mat-tab>
          </mat-tab-group>
        } @else {
          <div class="single-view-content">
            <app-active-transfers-table
              [transfers]="config().activeTransfers"
              [operationClass]="config().operationClass"
            ></app-active-transfers-table>
          </div>
        }
      </mat-card-content>
    </mat-card>
  `,
  styleUrls: ['./transfer-activity-panel.component.scss'],
})
export class TransferActivityPanelComponent {
  config = input.required<TransferActivityPanelConfig>();
  resetStats = output<void>();
}

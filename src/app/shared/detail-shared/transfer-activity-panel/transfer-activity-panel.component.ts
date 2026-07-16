import { Component, input, output, ChangeDetectionStrategy, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe } from '@ngx-translate/core';

import { ActiveTransfersTableComponent } from './active-transfers-table.component';
import { CompletedTransfersTableComponent } from './completed-transfers-table.component';
import { CheckResultsTableComponent } from './check-results-table.component';
import { SearchContainerComponent } from '../../components/search-container/search-container.component';
import { TransferActivityPanelConfig } from '@app/types';

@Component({
  selector: 'app-transfer-activity-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatIconModule,
    MatTabsModule,
    MatButtonModule,
    MatTooltipModule,
    TranslatePipe,
    ActiveTransfersTableComponent,
    CompletedTransfersTableComponent,
    CheckResultsTableComponent,
    SearchContainerComponent,
  ],
  template: `
    <mat-card class="detail-panel">
      <mat-card-header class="panel-header">
        <mat-card-title>
          <mat-icon
            style="color: var(--mat-sys-primary)"
            [svgIcon]="
              config().jobType === 'check' || config().jobType === 'cryptcheck'
                ? 'check-circle'
                : 'download'
            "
          ></mat-icon>
          <span>{{
            (config().jobType === 'check' || config().jobType === 'cryptcheck'
              ? 'shared.transferActivity.titleCheck'
              : 'shared.transferActivity.title'
            ) | translate
          }}</span>

          @if (config().completedTransfers.length > 0 || config().activeTransfers.length > 0) {
            <button
              matIconButton
              [class.search-open]="searchVisible()"
              (click)="toggleSearch()"
              [matTooltip]="'shared.search.toggle' | translate"
            >
              <mat-icon svgIcon="search"></mat-icon>
            </button>
          }

          @if (config().showHistory) {
            <button
              matIconButton
              (click)="isJobRunning() ? resetStats.emit() : deleteJob.emit()"
              [matTooltip]="
                (isJobRunning()
                  ? 'shared.transferActivity.resetStats'
                  : 'detailShared.jobs.actions.delete'
                ) | translate
              "
            >
              <mat-icon
                [svgIcon]="isJobRunning() ? 'broom' : 'trash'"
                [class]="isJobRunning() ? 'primary' : 'warn'"
              ></mat-icon>
            </button>
          }
        </mat-card-title>
      </mat-card-header>

      <app-search-container
        [visible]="searchVisible()"
        [searchText]="searchTerm()"
        (searchTextChange)="searchTerm.set($event)"
      ></app-search-container>

      <mat-card-content class="panel-content">
        @if (config().jobType === 'check' || config().jobType === 'cryptcheck') {
          <app-check-results-table
            [transfers]="config().completedTransfers"
            [config]="config()"
            [searchTerm]="searchTerm()"
          ></app-check-results-table>
        } @else if (
          config().showHistory &&
          config().activeTransfers.length > 0 &&
          config().completedTransfers.length > 0
        ) {
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
                  [jobType]="config().jobType || 'sync'"
                  [remoteName]="config().remoteName"
                  [searchTerm]="searchTerm()"
                ></app-active-transfers-table>
              </ng-template>
            </mat-tab>
            <mat-tab
              [label]="
                (config().jobType === 'check' || config().jobType === 'cryptcheck'
                  ? 'shared.transferActivity.tabs.recentCheck'
                  : 'shared.transferActivity.tabs.recent'
                ) | translate: { count: config().completedTransfers.length }
              "
            >
              <ng-template matTabContent>
                <app-completed-transfers-table
                  [transfers]="config().completedTransfers"
                  [jobType]="config().jobType || 'sync'"
                  [remoteName]="config().remoteName"
                  [searchTerm]="searchTerm()"
                ></app-completed-transfers-table>
              </ng-template>
            </mat-tab>
          </mat-tab-group>
        } @else if (config().showHistory && config().completedTransfers.length > 0) {
          <app-completed-transfers-table
            [transfers]="config().completedTransfers"
            [jobType]="config().jobType || 'sync'"
            [remoteName]="config().remoteName"
            [searchTerm]="searchTerm()"
          ></app-completed-transfers-table>
        } @else {
          <app-active-transfers-table
            [transfers]="config().activeTransfers"
            [jobType]="config().jobType || 'sync'"
            [remoteName]="config().remoteName"
            [searchTerm]="searchTerm()"
          ></app-active-transfers-table>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .detail-panel {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      .panel-content {
        padding: 0;
        overflow: hidden;
      }
      .search-open {
        background: rgba(var(--accent-color-rgb), 0.1) !important;
        color: var(--accent-color) !important;
      }
    }
  `,
})
export class TransferActivityPanelComponent {
  readonly config = input.required<TransferActivityPanelConfig>();
  readonly isJobRunning = input<boolean>(false);
  readonly resetStats = output<void>();
  readonly deleteJob = output<void>();

  readonly searchVisible = signal(false);
  readonly searchTerm = signal('');

  toggleSearch(): void {
    const nextVal = !this.searchVisible();
    this.searchVisible.set(nextVal);
    if (!nextVal) this.searchTerm.set('');
  }
}

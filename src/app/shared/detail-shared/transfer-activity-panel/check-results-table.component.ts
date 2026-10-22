import { ActivityProgressComponent } from './activity-progress.component';
import { ActivityPathsComponent } from './activity-paths.component';
import { Component, input, inject, ChangeDetectionStrategy, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import { JobActionType, TRANSFER_STATUS } from '@app/types';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { TransferOperationsService } from './transfer-operations.service';
import { BaseTransfersTableComponent } from './base-transfers-table.component';
import { AlertBannerComponent } from '../../components/alert-banner/alert-banner.component';
import {
  ActivityRow,
  activityBadge,
  activityError,
  canResolveCheck,
  effectiveTransferStatus,
} from './activity.utils';

@Component({
  selector: 'app-check-results-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [TransferOperationsService],
  imports: [
    ActivityPathsComponent,
    ActivityProgressComponent,
    MatIconModule,
    MatButtonModule,
    TranslatePipe,
    CopyToClipboardDirective,
    AlertBannerComponent,
  ],
  template: `
    <div class="card-list-container" (scroll)="onScroll($event)">
      @if (processedItems().length > 0) {
        @for (item of processedItems(); track item.uniqueId) {
          <div class="card-row-item" [class]="item.displayStatus">
            <div class="card-header">
              <div class="card-info-left">
                <mat-icon
                  svgIcon="file"
                  class="card-primary-icon file-icon"
                  [attr.title]="item.name"
                ></mat-icon>
                <span
                  class="card-title-text truncate"
                  [appCopyToClipboard]="item.name"
                  [attr.title]="'common.copy' | translate"
                  >{{ item.name }}</span
                >
              </div>
              <div class="card-info-right actions-group">
                <span class="app-pill" [class]="item.badge.cssClass">
                  <mat-icon [svgIcon]="item.badge.icon"></mat-icon>
                  {{ item.badge.text | translate }}
                </span>
                @if (canResolve(item)) {
                  <button
                    type="button"
                    class="action-button"
                    (click)="onResolve(item)"
                    [disabled]="isResolving(item)"
                    [attr.title]="item.resolveTooltip | translate"
                    [attr.aria-label]="item.resolveTooltip | translate"
                  >
                    <mat-icon
                      [svgIcon]="isResolving(item) ? 'spinner' : item.resolveIcon"
                      [class.colorful-spinner]="isResolving(item)"
                    ></mat-icon>
                  </button>
                }
              </div>
            </div>

            <app-activity-paths
              [item]="item"
              [rowId]="item.uniqueId"
              [jobType]="jobType()"
              [fallbackLabel]="remoteName()"
              [allowDelete]="true"
            ></app-activity-paths>

            @if (isResolving(item)) {
              <app-activity-progress [state]="item.resolveState"></app-activity-progress>
            }
            @if (item.relativeTime) {
              <div class="card-footer">
                <span class="time-text">{{ item.relativeTime }}</span>
              </div>
            }
            @if (item.displayError) {
              <app-alert-banner
                class="compact"
                severity="error"
                [description]="item.displayError"
                [appCopyToClipboard]="item.displayError"
                [attr.title]="'common.copy' | translate"
                tabindex="0"
                role="button"
              />
            }
          </div>
        }
        @if (filteredTransfers().length > displayLimit()) {
          <div class="infinite-scroll-loader">
            <button type="button" matButton (click)="loadMore()">
              {{ 'shared.transferActivity.loadMore' | translate }}
            </button>
          </div>
        }
      } @else if (searchTerm().trim() || statusFilter()) {
        <div class="empty-state">
          <mat-icon svgIcon="search"></mat-icon>
          <span>{{ 'shared.search.title' | translate }}</span>
          <p>{{ 'shared.search.description' | translate }}</p>
        </div>
      } @else {
        <div class="empty-state">
          <mat-icon svgIcon="check-circle"></mat-icon>
          <span>{{ 'shared.transferActivity.empty.noRecentCheck' | translate }}</span>
          <p>{{ 'shared.transferActivity.empty.recentHintCheck' | translate }}</p>
        </div>
      }
    </div>
  `,
})
export class CheckResultsTableComponent extends BaseTransfersTableComponent {
  readonly jobType = input<JobActionType>('check');
  readonly remoteName = input('');

  private readonly ops = inject(TransferOperationsService);
  private readonly notifications = inject(NotificationService);

  protected readonly canResolve = canResolveCheck;

  protected readonly processedItems = computed(() => {
    this.lang();
    return this.visibleTransfers().map(item => ({
      ...item,
      displayStatus: effectiveTransferStatus(item),
      displayError: activityError(item),
      uniqueId: JSON.stringify([item.jobid, item.srcFs, item.dstFs, item.name]),
      badge: activityBadge(item, this.jobType()),
      resolveIcon: item.status === TRANSFER_STATUS.MissingSource ? 'left-arrow' : 'right-arrow',
      resolveTooltip:
        item.status === TRANSFER_STATUS.MissingDestination
          ? 'shared.transferActivity.actions.resolveToDst'
          : item.status === TRANSFER_STATUS.MissingSource
            ? 'shared.transferActivity.actions.resolveToSrc'
            : 'shared.transferActivity.actions.resolveOverwrite',
      relativeTime: item.completedAt ? this.getRelativeTime(item.completedAt) : '',
    }));
  });

  async onResolve(item: ActivityRow): Promise<void> {
    if (!canResolveCheck(item) || this.isResolving(item)) return;
    this.resolvingIds.update(s => new Set(s).add(item.uniqueId));
    try {
      const path = item.name;

      if (item.status === TRANSFER_STATUS.Partial) {
        const confirmed = await this.notifications.confirmModal(
          this.translate.instant('shared.transferActivity.actions.resolveOverwriteTitle'),
          this.translate.instant('shared.transferActivity.actions.resolveOverwriteMessage', {
            name: path,
          }),
          'shared.transferActivity.actions.overwriteDst',
          'common.cancel',
          { icon: 'sync', color: 'accent' }
        );
        if (!confirmed) return;
      }
      const reverse = item.status === TRANSFER_STATUS.MissingSource;
      await this.ops.copyFile(item, reverse);
      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.actions.successSync')
      );
    } catch (e) {
      console.error('Failed to resolve difference:', e);
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failSync', {
          error: (e as Error).message || String(e),
        })
      );
    } finally {
      this.resolvingIds.update(s => {
        const next = new Set(s);
        next.delete(item.uniqueId);
        return next;
      });
    }
  }
}

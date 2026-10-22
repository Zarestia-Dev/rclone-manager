import { ActivityProgressComponent } from './activity-progress.component';
import { ActivityPathsComponent } from './activity-paths.component';
import { Component, input, inject, ChangeDetectionStrategy, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import { FormatFileSizePipe } from '@app/pipes';
import { CompletedTransfer, JobActionType } from '@app/types';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { TransferOperationsService } from './transfer-operations.service';
import { BaseTransfersTableComponent } from './base-transfers-table.component';
import { AlertBannerComponent } from '../../components/alert-banner/alert-banner.component';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import {
  ActivityRow,
  activityBadge,
  activityError,
  canCopyFailedTransfer,
  effectiveTransferStatus,
} from './activity.utils';

@Component({
  selector: 'app-completed-transfers-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [TransferOperationsService],
  imports: [
    ActivityPathsComponent,
    ActivityProgressComponent,
    MatIconModule,
    MatButtonModule,
    TranslatePipe,
    FormatFileSizePipe,
    AlertBannerComponent,
    CopyToClipboardDirective,
  ],
  template: `
    <div class="card-list-container" (scroll)="onScroll($event)">
      @if (processedItems().length > 0) {
        @for (transfer of processedItems(); track transfer.uniqueId) {
          <div class="card-row-item" [class]="transfer.displayStatus">
            <div class="card-header">
              <div class="card-info-left">
                <mat-icon
                  svgIcon="file"
                  class="card-primary-icon file-icon"
                  [attr.title]="transfer.name"
                ></mat-icon>
                <span class="card-title-text truncate" [title]="transfer.name">{{
                  transfer.name
                }}</span>
              </div>
              <div class="card-info-right actions-group">
                <span
                  class="app-pill"
                  [class]="transfer.badge.cssClass"
                  [attr.title]="transfer.displayError"
                >
                  <mat-icon [svgIcon]="transfer.badge.icon"></mat-icon>
                  {{ transfer.badge.text | translate }}
                </span>

                @if (canResolve(transfer)) {
                  <button
                    type="button"
                    class="action-button"
                    (click)="onResolve(transfer)"
                    [disabled]="isResolving(transfer)"
                    [attr.title]="'shared.transferActivity.actions.resolveToDst' | translate"
                    [attr.aria-label]="'shared.transferActivity.actions.resolveToDst' | translate"
                  >
                    <mat-icon
                      [svgIcon]="isResolving(transfer) ? 'spinner' : 'right-arrow'"
                    ></mat-icon>
                  </button>
                }
              </div>
            </div>

            <app-activity-paths
              [item]="transfer"
              [rowId]="transfer.uniqueId"
              [jobType]="jobType()"
              [fallbackLabel]="remoteName()"
              [allowDelete]="true"
            ></app-activity-paths>

            <div class="card-footer">
              <div class="card-footer-left">
                <span class="size-text">
                  @if (transfer.size >= 0) {
                    {{ transfer.size | formatFileSize }}
                  }
                  @if (transfer.bytes !== transfer.size && transfer.bytes > 0) {
                    <span class="size-transferred"
                      >({{ transfer.bytes | formatFileSize }}
                      {{ 'shared.transferActivity.table.transferred' | translate }})</span
                    >
                  }
                </span>
              </div>
              <div class="card-footer-right">
                @if (transfer.completedAt) {
                  <span class="time-text">{{ transfer.relativeTime }}</span>
                }
                @if (transfer.duration) {
                  <span class="duration-badge">{{ transfer.duration }}</span>
                }
              </div>
            </div>

            @if (isResolving(transfer)) {
              <app-activity-progress [state]="transfer.resolveState"></app-activity-progress>
            }
            @if (transfer.displayError) {
              <app-alert-banner
                class="compact"
                severity="error"
                [description]="transfer.displayError"
                [appCopyToClipboard]="transfer.displayError"
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
          <span>{{ 'shared.transferActivity.empty.noRecent' | translate }}</span>
          <p>{{ 'shared.transferActivity.empty.recentHint' | translate }}</p>
        </div>
      }
    </div>
  `,
})
export class CompletedTransfersTableComponent extends BaseTransfersTableComponent {
  readonly jobType = input<JobActionType>('sync');
  readonly remoteName = input<string>('');

  protected canResolve(item: CompletedTransfer): boolean {
    return canCopyFailedTransfer(item, this.jobType());
  }

  private readonly ops = inject(TransferOperationsService);
  private readonly notifications = inject(NotificationService);
  private readonly pathService = inject(PathService);

  protected readonly processedItems = computed(() => {
    this.lang();
    const counts = new Map<string, number>();
    return this.visibleTransfers().map(transfer => {
      const status = effectiveTransferStatus(transfer);
      const badge = activityBadge(transfer, this.jobType());
      const base = JSON.stringify([
        transfer.jobid,
        transfer.group,
        transfer.srcFs,
        transfer.dstFs,
        transfer.what,
        transfer.startedAt,
        transfer.completedAt,
        transfer.name,
      ]);
      const count = (counts.get(base) ?? 0) + 1;
      counts.set(base, count);
      const uniqueId = count === 1 ? base : `${base}#${count}`;

      return {
        ...transfer,
        displayStatus: status,
        displayError: activityError(transfer),
        relativeTime: transfer.completedAt ? this.getRelativeTime(transfer.completedAt) : '',
        duration:
          transfer.startedAt && transfer.completedAt
            ? this.getDuration(transfer.startedAt, transfer.completedAt)
            : '',
        badge,
        uniqueId,
      };
    });
  });

  private getDuration(startedAt: string, completedAt: string): string {
    const diff = Date.parse(completedAt) - Date.parse(startedAt);
    if (!Number.isFinite(diff) || diff < 0) return '';
    if (diff < 1000)
      return this.translate.instant('shared.transferActivity.time.duration.lessThanSecond');

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes <= 0)
      return this.translate.instant('shared.transferActivity.time.duration.seconds', { seconds });
    const hours = Math.floor(minutes / 60);
    if (hours <= 0)
      return this.translate.instant('shared.transferActivity.time.duration.minutes', {
        minutes,
        seconds: seconds % 60,
      });
    return this.translate.instant('shared.transferActivity.time.duration.hours', {
      hours,
      minutes: minutes % 60,
    });
  }

  async onResolve(item: ActivityRow): Promise<void> {
    if (!this.canResolve(item) || this.isResolving(item)) return;
    this.resolvingIds.update(s => new Set(s).add(item.uniqueId));
    try {
      await this.ops.copyFile(item);

      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.messages.resolveStarted', {
          name: this.pathService.extractName(item.name),
        })
      );
    } catch (e) {
      console.error('Failed to resolve failed transfer:', e);
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.messages.resolveFailed', { error: e })
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

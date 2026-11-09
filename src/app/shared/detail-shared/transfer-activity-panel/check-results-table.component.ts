import { ActivityProgressComponent } from './activity-progress.component';
import { ActivityPathsComponent } from './activity-paths.component';
import { Component, input, inject, ChangeDetectionStrategy, computed, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { TranslatePipe } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { FormatFileSizePipe } from '@app/pipes';
import { CompletedTransfer, JobActionType } from '@app/types';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { TransferOperationsService } from './transfer-operations.service';
import { BaseTransfersTableComponent } from './base-transfers-table.component';
import { ModalService } from 'src/app/services/ui/modal.service';
import {
  ActivityRow,
  CHECK_RESOLUTION_INFO,
  CheckDirection,
  activityBadge,
  activityError,
  checkResolution,
  checkRowId,
  compareSidesOf,
  effectiveTransferStatus,
  resolutionCounts,
  splitPath,
  withMember,
} from './activity.utils';

import { PillDirective } from '../../directives/pill.directive';
@Component({
  selector: 'app-check-results-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [TransferOperationsService],
  imports: [
    ActivityPathsComponent,
    ActivityProgressComponent,
    FormatFileSizePipe,
    MatIconModule,
    MatButtonModule,
    MatCheckboxModule,
    TranslatePipe,
    CopyToClipboardDirective,
    PillDirective,
  ],
  template: `
    <div class="card-list-container" (scroll)="onScroll($event)">
      @if (processedItems().length > 0) {
        @if (openItems().length > 0) {
          <div class="list-bar">
            <mat-checkbox
              class="list-bar-select"
              [checked]="allSelected()"
              [indeterminate]="selectedItems().length > 0 && !allSelected()"
              (change)="toggleAll($event.checked)"
            >
              {{
                'shared.transferActivity.bulk.selectAll' | translate: { count: openItems().length }
              }}
            </mat-checkbox>
          </div>
        }
        @for (item of processedItems(); track item.uniqueId) {
          <div
            class="card-row-item"
            [class]="item.displayStatus"
            [class.is-selected]="selection().has(item.uniqueId)"
          >
            <div class="card-header">
              <div class="card-info-left">
                @if (item.resolution) {
                  <mat-checkbox
                    [checked]="selection().has(item.uniqueId)"
                    (change)="toggle(item.uniqueId, $event.checked)"
                    [attr.aria-label]="item.name"
                  ></mat-checkbox>
                } @else {
                  <mat-icon svgIcon="file" class="card-primary-icon"></mat-icon>
                }
                <span class="card-title">
                  <span class="file-dir truncate" [title]="item.name">{{ item.dir }}</span>
                  <span
                    class="card-title-text truncate"
                    [appCopyToClipboard]="item.name"
                    [attr.title]="'common.copy' | translate"
                    >{{ item.base }}</span
                  >
                </span>
              </div>
              <div class="card-info-right">
                <span appPill [tone]="item.badge.tone">
                  <mat-icon [svgIcon]="item.badge.icon"></mat-icon>
                  {{ item.badge.text | translate }}
                </span>
                @if (item.resolution; as resolution) {
                  <button
                    type="button"
                    class="action-button"
                    (click)="onResolve(item)"
                    [disabled]="isResolving(item)"
                    [attr.title]="resolution.actionKey | translate"
                    [attr.aria-label]="resolution.actionKey | translate"
                  >
                    <mat-icon
                      [svgIcon]="isResolving(item) ? 'spinner' : resolution.icon"
                      [class.colorful-spinner]="isResolving(item)"
                    ></mat-icon>
                  </button>
                }
              </div>
            </div>

            <div class="card-footer">
              <div class="card-footer-left">
                @if (item.resolution; as resolution) {
                  <span
                    appPill
                    size="xs"
                    [tone]="resolution.tone"
                    [attr.title]="resolution.directionKey | translate"
                  >
                    <mat-icon [svgIcon]="resolution.icon"></mat-icon>
                    {{ resolution.labelKey | translate }}
                  </span>
                }
                @if (item.size >= 0) {
                  <span class="size-text">{{ item.size | formatFileSize }}</span>
                }
              </div>
              <div class="card-footer-right">
                @if (item.completedAt) {
                  <span>{{ item.relativeTime }}</span>
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
            @if (item.displayError) {
              <div class="error-entry">
                <mat-icon svgIcon="circle-info" aria-hidden="true"></mat-icon>
                <span>{{ item.displayError }}</span>
                <button
                  type="button"
                  class="action-button"
                  [appCopyToClipboard]="item.displayError"
                  [attr.title]="'common.copy' | translate"
                  [attr.aria-label]="'common.copy' | translate"
                >
                  <mat-icon svgIcon="copy" aria-hidden="true"></mat-icon>
                </button>
              </div>
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

      @if (selectedItems().length > 0) {
        <div
          class="bulk-bar"
          role="region"
          [attr.aria-label]="'shared.transferActivity.bulk.title' | translate"
        >
          <div class="bulk-summary">
            <strong>{{
              'shared.transferActivity.bulk.selected' | translate: { count: selectedItems().length }
            }}</strong>
            @if (selectedCounts().toDestination) {
              <span appPill tone="primary" size="xs">
                <mat-icon svgIcon="right-arrow"></mat-icon>
                {{
                  'shared.transferActivity.bulk.toDestination'
                    | translate: { count: selectedCounts().toDestination }
                }}
              </span>
            }
            @if (selectedCounts().toSource) {
              <span appPill tone="accent" size="xs">
                <mat-icon svgIcon="left-arrow"></mat-icon>
                {{
                  'shared.transferActivity.bulk.toSource'
                    | translate: { count: selectedCounts().toSource }
                }}
              </span>
            }
            @if (selectedCounts().choose) {
              <span appPill tone="orange" size="xs">
                <mat-icon svgIcon="right-left"></mat-icon>
                {{
                  'shared.transferActivity.bulk.choose'
                    | translate: { count: selectedCounts().choose }
                }}
              </span>
            }
          </div>
          <div class="bulk-actions">
            <button type="button" matButton (click)="clearSelection()">
              {{ 'shared.transferActivity.bulk.clear' | translate }}
            </button>
            @if (oneWayCount() > 0) {
              <button
                type="button"
                matButton="filled"
                [disabled]="bulkBusy()"
                (click)="applyOneWay()"
              >
                {{
                  'shared.transferActivity.bulk.applyOneWay' | translate: { count: oneWayCount() }
                }}
              </button>
            }
            @if (selectedCounts().choose > 0) {
              <button
                type="button"
                matButton="filled"
                [disabled]="bulkBusy()"
                (click)="reviewConflicts()"
              >
                {{
                  'shared.transferActivity.bulk.review'
                    | translate: { count: selectedCounts().choose }
                }}
              </button>
            }
          </div>
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
  private readonly modals = inject(ModalService);

  /** Ids the user ticked; only ids that still need a decision count. */
  protected readonly selection = signal<ReadonlySet<string>>(new Set());
  protected readonly bulkBusy = signal(false);

  /** Every difference still open under the current filter, also beyond the loaded window. */
  protected readonly openItems = computed(() =>
    this.filteredTransfers()
      .filter(item => checkResolution(item))
      .map(item => ({ ...item, uniqueId: checkRowId(item) }))
  );
  protected readonly selectedItems = computed(() => {
    const selection = this.selection();
    return this.openItems().filter(item => selection.has(item.uniqueId));
  });
  protected readonly selectedCounts = computed(() => resolutionCounts(this.selectedItems()));
  protected readonly oneWayCount = computed(
    () => this.selectedCounts().toDestination + this.selectedCounts().toSource
  );
  protected readonly allSelected = computed(
    () => this.openItems().length > 0 && this.selectedItems().length === this.openItems().length
  );

  protected readonly processedItems = computed(() => {
    this.lang();
    return this.visibleTransfers().map(item => {
      const resolution = checkResolution(item);
      return {
        ...item,
        ...splitPath(item.name),
        displayStatus: effectiveTransferStatus(item),
        displayError: activityError(item),
        uniqueId: checkRowId(item),
        badge: activityBadge(item, this.jobType()),
        resolution: resolution ? CHECK_RESOLUTION_INFO[resolution] : null,
        relativeTime: item.completedAt ? this.getRelativeTime(item.completedAt) : '',
      };
    });
  });

  protected toggle(id: string, checked: boolean): void {
    this.selection.update(selection => withMember(selection, id, checked));
  }

  protected toggleAll(checked: boolean): void {
    this.selection.set(checked ? new Set(this.openItems().map(item => item.uniqueId)) : new Set());
  }

  protected clearSelection(): void {
    this.selection.set(new Set());
  }

  /** Row action: copies a one-sided file at once, asks which side wins for a differing one. */
  async onResolve(item: ActivityRow): Promise<void> {
    const resolution = checkResolution(item);
    if (!resolution || this.isResolving(item)) return;
    if (resolution === 'choose') {
      await this.review([item]);
      return;
    }
    if (await this.resolve(item, resolution)) {
      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.actions.successSync')
      );
    }
  }

  protected async applyOneWay(): Promise<void> {
    const items = this.selectedItems().filter(item => checkResolution(item) !== 'choose');
    if (!items.length || this.bulkBusy()) return;
    this.bulkBusy.set(true);
    let started = 0;
    try {
      for (const item of items) {
        const direction = checkResolution(item) as CheckDirection;
        if (await this.resolve(item, direction, false)) started++;
      }
    } finally {
      this.bulkBusy.set(false);
    }
    if (started === items.length) {
      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.bulk.started', { count: started })
      );
    } else if (started > 0) {
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.bulk.partial', {
          started,
          failed: items.length - started,
        })
      );
    }
  }

  protected async reviewConflicts(): Promise<void> {
    if (this.bulkBusy()) return;
    await this.review(this.selectedItems().filter(item => checkResolution(item) === 'choose'));
  }

  /**
   * Asks about the files in one dialog. Each answer starts its change at once and the dialog goes
   * on to the next file, so the list shows each file as busy while it is being copied.
   */
  private async review(items: ActivityRow[]): Promise<void> {
    if (!items.length) return;
    this.bulkBusy.set(true);
    try {
      await firstValueFrom(
        this.modals
          .openCheckCompare({
            entries: items.map(item => ({ name: item.name, ...compareSidesOf(item) })),
            apply: (index, direction) => void this.resolveAndSay(items[index], direction),
          })
          .afterClosed()
      );
    } finally {
      this.bulkBusy.set(false);
    }
  }

  private async resolveAndSay(item: CompletedTransfer, direction: CheckDirection): Promise<void> {
    if (await this.resolve(item, direction)) {
      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.actions.successSync')
      );
    }
  }

  /** Starts the copy job for one file. Returns whether the job was started. */
  private async resolve(
    item: CompletedTransfer,
    direction: CheckDirection,
    report = true
  ): Promise<boolean> {
    const id = checkRowId(item);
    this.resolvingIds.update(ids => withMember(ids, id, true));
    try {
      await this.ops.resolveCheck(item, direction);
      this.selection.update(selection => withMember(selection, id, false));
      return true;
    } catch (e) {
      console.error('Failed to resolve difference:', e);
      if (report) {
        this.notifications.showError(
          this.translate.instant('shared.transferActivity.actions.failSync', {
            error: (e as Error).message || String(e),
          })
        );
      }
      return false;
    } finally {
      this.resolvingIds.update(ids => withMember(ids, id, false));
    }
  }
}

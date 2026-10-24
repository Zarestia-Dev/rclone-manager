import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { JobActionType } from '@app/types';
import { TransferOperationsService } from './transfer-operations.service';
import { ActivityActionItem, ActivityTarget } from './activity.utils';

const ACTIVITY_TARGETS: readonly ActivityTarget[] = ['src', 'dst'];

@Component({
  selector: 'app-activity-paths',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, TranslatePipe],
  template: `
    <div class="card-paths">
      @for (path of paths(); track path.target; let first = $first) {
        <div class="path-segment">
          @if (!first) {
            <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>
          }
          <div
            class="app-pill p-dim path-endpoint"
            [class]="path.target"
            role="group"
            [attr.aria-label]="path.fs"
          >
            <code class="truncate" [title]="path.fs">{{ path.fs }}</code>
            @if (path.canAccess) {
              @let key = rowId() + '-' + path.target;
              @let action = ops.pendingActions().get(key);
              <div class="path-actions">
                @if (path.features?.PublicLink || path.features?.loading) {
                  @let loading = action === 'link' || !!path.features.loading;
                  <button
                    type="button"
                    class="action-button"
                    [disabled]="!!action || loading"
                    (click)="ops.copyUrl(item(), path.target, key)"
                    [attr.title]="'shared.transferActivity.actions.copyUrl' | translate"
                    [attr.aria-label]="'shared.transferActivity.actions.copyUrl' | translate"
                  >
                    <mat-icon
                      [svgIcon]="loading ? 'spinner' : 'link'"
                      [class.colorful-spinner]="loading"
                    ></mat-icon>
                  </button>
                }
                <button
                  type="button"
                  class="action-button"
                  [disabled]="!!action"
                  (click)="ops.download(item(), path.target, key)"
                  [attr.title]="'shared.transferActivity.actions.download' | translate"
                  [attr.aria-label]="'shared.transferActivity.actions.download' | translate"
                >
                  <mat-icon
                    [svgIcon]="action === 'download' ? 'spinner' : 'download'"
                    [class.colorful-spinner]="action === 'download'"
                  ></mat-icon>
                </button>
                @if (allowDelete()) {
                  <button
                    type="button"
                    class="action-button"
                    [disabled]="!!action"
                    (click)="ops.deleteFile(item(), path.target, key)"
                    [attr.title]="'common.delete' | translate"
                    [attr.aria-label]="'common.delete' | translate"
                  >
                    <mat-icon
                      [svgIcon]="action === 'delete' ? 'spinner' : 'trash'"
                      class="warn"
                      [class.colorful-spinner]="action === 'delete'"
                    ></mat-icon>
                  </button>
                }
              </div>
            }
          </div>
        </div>
      } @empty {
        @if (fallbackLabel()) {
          <code class="truncate" [title]="fallbackLabel()">{{ fallbackLabel() }}</code>
        }
      }
    </div>
  `,
})
export class ActivityPathsComponent {
  readonly item = input.required<ActivityActionItem>();
  readonly rowId = input.required<string>();
  readonly jobType = input.required<JobActionType>();
  readonly fallbackLabel = input('');
  readonly allowDelete = input(false);
  protected readonly ops = inject(TransferOperationsService);
  protected readonly paths = computed(() => {
    const item = this.item();
    return ACTIVITY_TARGETS.flatMap(target => {
      const fs = this.ops.getFs(item, target);
      if (!fs) return [];
      const canAccess = this.ops.canAccess(item, target, this.jobType());
      return [
        {
          target,
          fs,
          canAccess,
          features: canAccess ? this.ops.getLinkFeatures(fs) : undefined,
        },
      ];
    });
  });
}

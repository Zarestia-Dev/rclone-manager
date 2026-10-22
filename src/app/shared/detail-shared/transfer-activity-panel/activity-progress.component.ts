import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslatePipe } from '@ngx-translate/core';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { ResolveState } from '@app/types';

@Component({
  selector: 'app-activity-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatProgressBarModule, TranslatePipe, FormatFileSizePipe, FormatTimePipe],
  template: `
    <div class="card-progress">
      <mat-progress-bar
        [mode]="preparing() ? 'indeterminate' : 'determinate'"
        [value]="percentage()"
      ></mat-progress-bar>
      <span class="percentage-text">
        @if (preparing()) {
          {{ 'shared.transferActivity.status.preparing' | translate }}
        } @else if (percentage() === 100) {
          {{ 'shared.transferActivity.status.finalizing' | translate }}
        } @else {
          {{ percentage() }}%
        }
      </span>
    </div>
    @if (state(); as progress) {
      <div class="card-footer">
        <div class="card-footer-left">
          @if (progress.size >= 0) {
            <span class="size-text"
              >{{ progress.bytes | formatFileSize }} / {{ progress.size | formatFileSize }}</span
            >
          } @else {
            <span class="size-text">{{ progress.bytes | formatFileSize }}</span>
          }
        </div>
        <div class="card-footer-right">
          @if (progress.speed > 0) {
            <span class="speed-text">{{ progress.speed | formatFileSize }}/s</span>
          }
          @if (progress.eta > 0) {
            <span class="eta-text">{{ progress.eta | formatTime }}</span>
          }
        </div>
      </div>
    }
  `,
})
export class ActivityProgressComponent {
  readonly state = input<ResolveState | null>();
  protected readonly preparing = computed(() => {
    const state = this.state();
    return !state || state.isPreparing || state.size < 0 || !Number.isFinite(state.percentage);
  });
  protected readonly percentage = computed(() =>
    this.preparing() ? 0 : Math.max(0, Math.min(100, this.state()?.percentage || 0))
  );
}

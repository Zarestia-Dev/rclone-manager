import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-config-form-skeleton',
  imports: [TranslatePipe],
  template: `
    <div
      role="status"
      [attr.aria-label]="label() || ('wizards.remoteConfig.loadingOptions' | translate)"
    >
      <div class="skeleton-form" [class.selection]="variant() === 'selection'" aria-hidden="true">
        @for (field of rows(); track field) {
          <div class="skeleton-form-row">
            <span class="skeleton-text skeleton-label"></span>
            <div class="skeleton-field animate-shimmer">
              <span class="skeleton-text skeleton-value"></span>
            </div>
            <span class="skeleton-text skeleton-hint"></span>
          </div>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .skeleton-form {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xl);
      padding-block: var(--space-sm) var(--space-xl);
    }

    .skeleton-form-row {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
    }

    .skeleton-text {
      display: block;
      height: var(--space-xs);
      border-radius: var(--radius-xxs);
      background: var(--bg-elevated-4);
    }

    .skeleton-label {
      width: 24%;
      max-width: calc(var(--space-2xl) * 5);
      margin-inline-start: var(--space-xxs);
      height: var(--space-sm);
    }

    .skeleton-field {
      display: flex;
      align-items: center;
      box-sizing: border-box;
      padding-inline: var(--space-md);
      margin: 0;
      background: linear-gradient(
        100deg,
        var(--bg-elevated-1) 30%,
        var(--bg-elevated-3) 50%,
        var(--bg-elevated-1) 70%
      );
      background-size: 200% 100%;
      width: 100%;
      height: calc(var(--space-2xl) + var(--space-xl));
      border-radius: var(--radius-md);
      animation-duration: 3s;
      animation-timing-function: linear;
    }

    .skeleton-value {
      width: 35%;
    }

    .skeleton-hint {
      width: 52%;
      margin-inline-start: var(--space-md);
      background: var(--bg-elevated-2);
    }

    .skeleton-form-row:nth-child(even) {
      .skeleton-label {
        width: 32%;
      }

      .skeleton-value {
        width: 48%;
      }

      .skeleton-hint {
        width: 38%;
      }
    }

    .skeleton-form.selection {
      min-height: calc(var(--space-2xl) * 7);
    }

    @media (prefers-reduced-motion: reduce) {
      .skeleton-field {
        animation: none;
        background: var(--bg-elevated-2);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfigFormSkeletonComponent {
  readonly label = input('');
  readonly variant = input<'selection' | 'fields'>('fields');
  readonly fieldCount = input(4);
  readonly rows = computed(() =>
    Array.from(
      { length: this.variant() === 'selection' ? 1 : Math.max(1, this.fieldCount()) },
      (_, index) => index
    )
  );
}

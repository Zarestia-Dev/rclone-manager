import { PillTone } from '../../types/pill';
import { Component, ChangeDetectionStrategy, input, output, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';

export type AlertSeverity = 'info' | 'warning' | 'error' | 'success' | 'dim';

/** The colour role (tone scope, custom-theme.scss) of each severity. */
const SEVERITY_TONE: Record<AlertSeverity, PillTone> = {
  info: 'accent',
  warning: 'orange',
  error: 'warn',
  success: 'primary',
  dim: 'dim',
};

@Component({
  selector: 'app-alert-banner',
  imports: [MatIconModule, TranslatePipe],
  templateUrl: './alert-banner.component.html',
  styleUrl: './alert-banner.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // Only an error interrupts a screen reader; the rest is announced when it appears or changes,
    // without cutting off what is being read, and a banner already on screen isn't announced.
    '[attr.role]': "severity() === 'error' ? 'alert' : 'status'",
    '[class]': 'severity()',
    '[attr.data-tone]': 'tone()',
  },
})
export class AlertBannerComponent {
  readonly title = input<string>('');
  readonly description = input<string>('');
  readonly severity = input<AlertSeverity>('warning');
  readonly icon = input<string>('');
  readonly linkUrl = input<string>('');
  readonly linkText = input<string>('');
  readonly dismissable = input<boolean>(false);
  readonly dismissTooltip = input<string>('');
  readonly dismiss = output<void>();

  readonly tone = computed(() => SEVERITY_TONE[this.severity()]);

  readonly resolvedIcon = computed(() => {
    const customIcon = this.icon();
    if (customIcon) return customIcon;

    switch (this.severity()) {
      case 'info':
        return 'circle-info';
      case 'error':
        return 'circle-xmark';
      case 'success':
        return 'check-circle';
      case 'dim':
        return 'circle-info';
      case 'warning':
      default:
        return 'warning';
    }
  });
}

import { Component, ChangeDetectionStrategy, input, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

export type AlertSeverity = 'info' | 'warning' | 'error' | 'success';

@Component({
  selector: 'app-alert-banner',
  imports: [MatIconModule],
  templateUrl: './alert-banner.component.html',
  styleUrl: './alert-banner.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'alert',
    '[class]': 'severity()',
  },
})
export class AlertBannerComponent {
  readonly title = input<string>('');
  readonly description = input<string>('');
  readonly severity = input<AlertSeverity>('warning');
  readonly icon = input<string>('');
  readonly linkUrl = input<string>('');
  readonly linkText = input<string>('');

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
      case 'warning':
      default:
        return 'warning';
    }
  });
}

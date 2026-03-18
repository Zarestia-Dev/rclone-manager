import { Component, inject, input, output, computed, ChangeDetectionStrategy } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ServeListItem } from '@app/types';
import { getRemoteNameFromFs, NotificationService } from '@app/services';

interface TypeInfo {
  icon: string;
}

const TYPE_INFO: Record<string, TypeInfo> = {
  http: { icon: 'globe' },
  webdav: { icon: 'cloud' },
  ftp: { icon: 'file-arrow-up' },
  sftp: { icon: 'lock' },
  nfs: { icon: 'server' },
  dlna: { icon: 'tv' },
  restic: { icon: 'shield' },
  s3: { icon: 'bucket' },
};

const DEFAULT_ICON = 'satellite-dish';
const URL_BASED_PROTOCOLS = new Set(['http', 'webdav', 'ftp', 'sftp', 's3']);

@Component({
  selector: 'app-serve-card',
  standalone: true,
  imports: [
    UpperCasePipe,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    TranslateModule,
  ],
  templateUrl: './serve-card.component.html',
  styleUrl: './serve-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServeCardComponent {
  private readonly translate = inject(TranslateService);
  private readonly notificationService = inject(NotificationService);

  serve = input.required<ServeListItem>();
  showRemoteName = input(false);

  stopServe = output<ServeListItem>();
  cardClick = output<ServeListItem>();

  serveIcon = computed<string>(() => {
    const type = this.serve().params.type.toLowerCase();
    return TYPE_INFO[type]?.icon ?? DEFAULT_ICON;
  });

  serveUrl = computed<string | null>(() => {
    const {
      params: { type, addr },
    } = this.serve() as unknown as {
      params: { type: string; addr: string } & ServeListItem['params'];
    };
    const normalizedType = type.toLowerCase();
    return URL_BASED_PROTOCOLS.has(normalizedType) ? `${normalizedType}://${addr}` : null;
  });

  optionsData = computed<{ keys: string[]; tooltip: string }>(() => {
    const params = this.serve().params;
    const keys = Object.keys(params);

    if (keys.length === 0) {
      return { keys: [], tooltip: this.translate.instant('shared.serveCard.messages.noOptions') };
    }

    const tooltip = keys
      .map(key => {
        const value = params[key as keyof typeof params];
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const nested = Object.entries(value)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join('\n');
          return `${key}:\n${nested}`;
        }
        return `${key}: ${JSON.stringify(value)}`;
      })
      .join('\n');

    return { keys, tooltip };
  });

  remoteName = computed<string>(() => getRemoteNameFromFs(this.serve().params.fs));

  onStopServe(): void {
    this.stopServe.emit(this.serve());
  }

  onCopyToClipboard(text: string, messageKey: string): void {
    try {
      navigator.clipboard.writeText(text);
      this.notificationService.showSuccess(this.translate.instant(messageKey));
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
      this.notificationService.showError(
        this.translate.instant('shared.serveCard.messages.copyFailed')
      );
    }
  }

  onCardClick(): void {
    this.cardClick.emit(this.serve());
  }
}

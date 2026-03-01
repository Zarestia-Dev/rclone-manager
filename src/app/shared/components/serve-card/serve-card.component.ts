import {
  Component,
  Output,
  EventEmitter,
  inject,
  input,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ServeListItem } from '@app/types';
import { IconService } from '@app/services';

interface TypeInfo {
  icon: string;
  description: string;
}

const TYPE_INFO: Record<string, TypeInfo> = {
  http: { icon: 'globe', description: 'Serve files via HTTP' },
  webdav: { icon: 'cloud', description: 'WebDAV for file access' },
  ftp: { icon: 'file-arrow-up', description: 'FTP file transfer' },
  sftp: { icon: 'lock', description: 'Secure FTP over SSH' },
  nfs: { icon: 'server', description: 'Network File System' },
  dlna: { icon: 'tv', description: 'DLNA media server' },
  restic: { icon: 'shield', description: 'Restic REST server' },
  s3: { icon: 'bucket', description: 'Amazon S3 compatible server' },
};

const DEFAULT_TYPE_INFO: TypeInfo = { icon: 'satellite-dish', description: 'Serve' };
const URL_BASED_PROTOCOLS = ['http', 'webdav', 'ftp', 'sftp', 's3'];

@Component({
  selector: 'app-serve-card',
  standalone: true,
  imports: [
    CommonModule,
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
  readonly iconService = inject(IconService);
  private translate = inject(TranslateService);

  serve = input.required<ServeListItem>();
  showRemoteName = input(false);

  @Output() stopServe = new EventEmitter<ServeListItem>();
  @Output() copyToClipboard = new EventEmitter<{ text: string; message: string }>();
  @Output() cardClick = new EventEmitter<ServeListItem>();

  serveTypeInfo = computed<TypeInfo>(() => {
    const serveType = this.serve().params.type.toLowerCase();
    const defaultInfo = DEFAULT_TYPE_INFO;
    const info = TYPE_INFO[serveType] || defaultInfo;
    const typeKey = TYPE_INFO[serveType] ? serveType : 'default';

    return {
      icon: info.icon,
      description: this.translate.instant(`shared.serveCard.types.${typeKey}`),
    };
  });

  serveUrl = computed<string | null>(() => {
    const serve = this.serve();
    const type = serve.params.type.toLowerCase();
    if (URL_BASED_PROTOCOLS.includes(type)) {
      return `${type}://${serve.addr}`;
    }
    return null;
  });

  optionsTooltip = computed<string>(() => {
    const { ...options } = this.serve().params;

    const keys = Object.keys(options);
    if (keys.length === 0) {
      return this.translate.instant('shared.serveCard.messages.noOptions');
    }

    return keys
      .map(key => {
        const value = options[key as keyof typeof options];
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const nestedOptions = Object.entries(value)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join('\n');
          return `${key}:\n${nestedOptions}`;
        }
        return `${key}: ${JSON.stringify(value)}`;
      })
      .join('\n');
  });

  optionKeys = computed<string[]>(() => {
    const { ...options } = this.serve().params;
    return Object.keys(options);
  });

  remoteName = computed<string>(() => {
    return this.serve().params.fs.split(':')[0];
  });

  onStopServe(): void {
    this.stopServe.emit(this.serve());
  }

  onCopyToClipboard(text: string, messageKey: string): void {
    const message = this.translate.instant(messageKey);
    this.copyToClipboard.emit({ text, message });
  }

  onCardClick(): void {
    this.cardClick.emit(this.serve());
  }
}

import { Component, Output, EventEmitter, inject, input, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ServeListItem } from '@app/types';
import { IconService } from '../../services/icon.service';

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
  imports: [CommonModule, MatCardModule, MatIconModule, MatButtonModule, MatTooltipModule],
  templateUrl: './serve-card.component.html',
  styleUrl: './serve-card.component.scss',
})
export class ServeCardComponent {
  readonly iconService = inject(IconService);

  serve = input.required<ServeListItem>();
  showRemoteName = input(false);

  @Output() stopServe = new EventEmitter<ServeListItem>();
  @Output() copyToClipboard = new EventEmitter<{ text: string; message: string }>();
  @Output() cardClick = new EventEmitter<ServeListItem>();

  serveTypeInfo = computed<TypeInfo>(() => {
    const serveType = this.serve().params.type.toLowerCase();
    return TYPE_INFO[serveType] || DEFAULT_TYPE_INFO;
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
      return 'No additional options';
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

  onCopyToClipboard(text: string, message: string): void {
    this.copyToClipboard.emit({ text, message });
  }

  onCardClick(): void {
    this.cardClick.emit(this.serve());
  }
}

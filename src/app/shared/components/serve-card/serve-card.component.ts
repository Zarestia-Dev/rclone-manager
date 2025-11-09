import { Component, Input, Output, EventEmitter, inject } from '@angular/core';
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

  @Input({ required: true }) serve!: ServeListItem;
  @Input() showRemoteName = false; // Show remote name for general overview

  @Output() stopServe = new EventEmitter<ServeListItem>();
  @Output() copyToClipboard = new EventEmitter<{ text: string; message: string }>();
  @Output() cardClick = new EventEmitter<ServeListItem>();

  /**
   * Gets the icon and description for a serve type.
   */
  getServeTypeInfo(type: string): TypeInfo {
    return TYPE_INFO[type.toLowerCase()] || DEFAULT_TYPE_INFO;
  }

  /**
   * Generates a full URL for URL-based protocols.
   */
  getServeUrl(serve: ServeListItem): string | null {
    const type = serve.params.type.toLowerCase();
    if (URL_BASED_PROTOCOLS.includes(type)) {
      return `${type}://${serve.addr}`;
    }
    return null;
  }

  /**
   * Formats the serve options for a tooltip.
   */
  getOptionsTooltip(params: ServeListItem['params']): string {
    // Remove keys that are already displayed elsewhere
    const { fs, type, ...options } = params;

    const keys = Object.keys(options);
    if (keys.length === 0) {
      return 'No additional options';
    }

    // Format as "key: value" pairs
    return keys
      .map(key => {
        const value = options[key as keyof typeof options];
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          // Handle nested objects like vfsOpt
          const nestedOptions = Object.entries(value)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join('\n');
          return `${key}:\n${nestedOptions}`;
        }
        // Handle simple values, arrays, or null
        return `${key}: ${JSON.stringify(value)}`;
      })
      .join('\n');
  }

  /**
   * Gets the keys of the options object, excluding 'fs' and 'type'.
   */
  getOptionKeys(params: ServeListItem['params']): string[] {
    if (!params) return [];
    const { fs, type, ...options } = params;
    return Object.keys(options);
  }

  /**
   * Extracts the remote name from the serve fs parameter.
   */
  getRemoteName(serve: ServeListItem): string {
    return serve.params.fs.split(':')[0];
  }

  onStopServe(): void {
    this.stopServe.emit(this.serve);
  }

  onCopyToClipboard(text: string, message: string): void {
    this.copyToClipboard.emit({ text, message });
  }

  onCardClick(): void {
    this.cardClick.emit(this.serve);
  }
}

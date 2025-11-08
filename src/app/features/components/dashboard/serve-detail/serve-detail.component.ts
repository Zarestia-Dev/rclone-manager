import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  ChangeDetectionStrategy,
  inject,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Remote, ServeListItem, RemoteSettings, SettingsPanelConfig } from '@app/types';
import { IconService } from '../../../../shared/services/icon.service';
import { ServeManagementService } from '@app/services';
import { Subject, takeUntil } from 'rxjs';
import { SettingsPanelComponent } from '../../../../shared/detail-shared';
import { ClipboardModule, Clipboard } from '@angular/cdk/clipboard';

// --- Interfaces and Constants ---
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
// ----------------------------------

interface SettingsSection {
  key: string;
  title: string;
  icon: string;
  configKey?: string;
}

@Component({
  selector: 'app-serve-detail',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatDividerModule,
    MatTooltipModule,
    MatSnackBarModule,
    SettingsPanelComponent,
    ClipboardModule,
  ],
  templateUrl: './serve-detail.component.html',
  styleUrl: './serve-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServeDetailComponent implements OnInit, OnDestroy {
  readonly iconService = inject(IconService);
  private readonly serveManagementService = inject(ServeManagementService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly clipboard = inject(Clipboard);
  private destroy$ = new Subject<void>();

  @Input() selectedRemote!: Remote;
  @Input() remoteSettings: RemoteSettings = {};
  @Output() startServeClick = new EventEmitter<string>();
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
    initialSection?: string;
  }>();

  remoteServes: ServeListItem[] = [];

  readonly SERVE_SECTIONS: SettingsSection[] = [
    { key: 'serve', title: 'Protocol Options', icon: 'satellite-dish' },
  ];

  readonly ADVANCED_SECTIONS: SettingsSection[] = [
    { key: 'filter', title: 'Filter Options', icon: 'filter', configKey: 'filterConfig' },
    { key: 'vfs', title: 'VFS Options', icon: 'vfs', configKey: 'vfsConfig' },
    { key: 'backend', title: 'Backend Config', icon: 'server', configKey: 'backendConfig' },
  ];

  ngOnInit(): void {
    this.serveManagementService.runningServes$.pipe(takeUntil(this.destroy$)).subscribe(serves => {
      this.remoteServes = this.filterRemoteServes(serves);
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private filterRemoteServes(serves: ServeListItem[]): ServeListItem[] {
    return serves.filter(serve => {
      const remoteName = serve.params.fs.split(':')[0];
      return remoteName === this.selectedRemote.remoteSpecs.name;
    });
  }

  private getSettingsForSection(section: SettingsSection): Record<string, unknown> {
    const serveConfig = this.remoteSettings?.['serveConfig'];
    if (!serveConfig) return {};
    if (section.key === 'serve') {
      return (serveConfig.options as Record<string, unknown>) || {};
    }
    if (section.configKey) {
      return (serveConfig[section.configKey] as Record<string, unknown>) || {};
    }
    return {};
  }

  getSettingsPanelConfig(section: SettingsSection): SettingsPanelConfig {
    const settings = this.getSettingsForSection(section);
    return {
      section: {
        key: section.key,
        title: section.title,
        icon: section.icon,
      },
      settings,
      hasSettings: Object.keys(settings).length > 0,
      restrictMode: false,
    };
  }

  onEditSettings(event: { section: string }): void {
    this.openRemoteConfigModal.emit({
      editTarget: 'serve',
      initialSection: event.section,
      existingConfig: {
        serveConfig: this.remoteSettings?.['serveConfig'],
      },
    });
  }

  async stopServe(serve: ServeListItem): Promise<void> {
    try {
      const remoteName = serve.params.fs.split(':')[0];
      await this.serveManagementService.stopServe(serve.id, remoteName);
      this.snackBar.open('Serve stopped successfully', 'Close', { duration: 3000 });
    } catch (error) {
      console.error('Error stopping serve:', error);
      this.snackBar.open('Failed to stop serve', 'Close', { duration: 5000 });
    }
  }

  onStartServeClick(): void {
    this.startServeClick.emit(this.selectedRemote.remoteSpecs.name);
  }

  // --- Helper Methods ---

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
   * Copies text to the clipboard and shows a snackbar.
   */
  copyToClipboard(text: string, message: string): void {
    this.clipboard.copy(text);
    this.snackBar.open(message, 'Close', { duration: 2000 });
  }

  /**
   * Gets the keys of the options object, excluding 'fs' and 'type'.
   */
  getOptionKeys(params: ServeListItem['params']): string[] {
    if (!params) return [];
    const { fs, type, ...options } = params;
    return Object.keys(options);
  }
}

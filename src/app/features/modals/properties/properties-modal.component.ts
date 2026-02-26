import {
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { UpperCasePipe, DecimalPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatChipsModule } from '@angular/material/chips';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import {
  RemoteManagementService,
  NautilusService,
  RemoteFacadeService,
  ModalService,
  NotificationService,
  IconService,
} from '@app/services';
import { Entry, FileBrowserItem, FsInfo } from '@app/types';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

interface ExpiryOption {
  value: string;
  label: string;
}

@Component({
  selector: 'app-properties-modal',
  standalone: true,
  imports: [
    UpperCasePipe,
    DecimalPipe,
    DatePipe,
    FormsModule,
    MatDialogModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
    MatTooltipModule,
    MatChipsModule,
    MatSelectModule,
    MatFormFieldModule,
    FormatFileSizePipe,
    TranslateModule,
  ],
  templateUrl: './properties-modal.component.html',
  styleUrls: ['./properties-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PropertiesModalComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<PropertiesModalComponent>);
  public data: {
    remoteName: string;
    path: string;
    isLocal: boolean;
    item?: Entry | null;
    remoteType?: string;
    /** Cached FsInfo from Nautilus (avoids duplicate API calls) */
    fsInfo?: FsInfo | null;
  } = inject(MAT_DIALOG_DATA);

  private remoteManagementService = inject(RemoteManagementService);
  private nautilusService = inject(NautilusService);
  private remoteFacadeService = inject(RemoteFacadeService);
  private iconService = inject(IconService);
  private translate = inject(TranslateService);
  private modalService = inject(ModalService);
  private notificationService = inject(NotificationService);

  // Separate loading states
  readonly loadingStat = signal(true);
  readonly loadingSize = signal(true);
  readonly loadingDiskUsage = signal(true);
  readonly loadingHashes = signal(false);

  readonly item = signal<Entry | null>(null);
  readonly size = signal<{ count: number; bytes: number } | null>(null);
  readonly diskUsage = signal<{ total?: number; used?: number; free?: number } | null>(null);
  readonly displayLocation = signal('');

  // Hash related state
  readonly supportedHashes = signal<string[]>([]);
  readonly fileHashes = signal<Record<string, string>>({});
  readonly loadingHashTypes = signal<Set<string>>(new Set()); // Track which hash types are currently loading
  readonly hashError = signal<string | null>(null);
  readonly copiedHash = signal<string | null>(null); // Track which hash was just copied

  // Public Link state
  readonly supportsPublicLink = signal(false);
  readonly publicLinkUrl = signal<string | null>(null);
  readonly loadingPublicLink = signal(false);
  readonly publicLinkError = signal<string | null>(null);
  readonly copiedLink = signal(false);
  readonly selectedExpiry = signal(''); // Empty = no expiry

  // Expiry options for public links
  readonly expiryOptions: ExpiryOption[] = [
    { value: '', label: 'fileBrowser.properties.expiry.never' },
    { value: '1h', label: 'fileBrowser.properties.expiry.1h' },
    { value: '1d', label: 'fileBrowser.properties.expiry.1d' },
    { value: '7d', label: 'fileBrowser.properties.expiry.7d' },
    { value: '30d', label: 'fileBrowser.properties.expiry.30d' },
  ];

  // Reactive Star State derived from Service
  readonly isStarred = computed(() =>
    this.nautilusService.isSaved('starred', this.data.remoteName, this.data.path)
  );

  /** Get hash entries as array for template iteration */
  readonly hashEntries = computed<{ type: string; value: string }[]>(() => {
    return Object.entries(this.fileHashes()).map(([type, value]) => ({ type, value }));
  });

  /** Get uncalculated hash types */
  readonly uncalculatedHashes = computed<string[]>(() => {
    const hashes = this.fileHashes();
    return this.supportedHashes().filter(h => !hashes[h]);
  });

  /** Check if file has any hashes calculated */
  readonly hasHashes = computed(() => Object.keys(this.fileHashes()).length > 0);

  /** Check if this is a file (not directory) */
  readonly isFile = computed(() => {
    const i = this.item();
    return i !== null && !i.IsDir;
  });

  // Bulk Hash State (Directories)
  readonly bulkHashResult = signal<string | null>(null);
  readonly bulkHashType = signal<string | null>(null);
  readonly calculatingBulkHash = signal(false);
  readonly bulkHashError = signal<string | null>(null);

  ngOnInit(): void {
    const { remoteName, path, isLocal, item } = this.data;

    // Set the item immediately
    this.item.set(item ?? null);
    this.loadingStat.set(false);

    // Construct the display location string
    if (isLocal) {
      this.displayLocation.set(remoteName);
    } else {
      const sep = remoteName && !remoteName.endsWith(':') ? ':' : '';
      this.displayLocation.set(`${remoteName}${sep}${path}`);
    }

    const currentItem = this.item();
    const targetIsDir = currentItem ? !!currentItem.IsDir : true;

    // 1. Get Size/Count (if directory)
    if (targetIsDir) {
      this.remoteManagementService
        .getSize(remoteName, path, 'ui')
        .then(size => {
          this.size.set(size);
          this.loadingSize.set(false);
        })
        .catch(err => {
          console.error('Failed to load size', err);
          this.loadingSize.set(false);
        });
    } else if (currentItem) {
      this.size.set({ count: 1, bytes: currentItem.Size });
      this.loadingSize.set(false);
    } else {
      this.loadingSize.set(false);
    }

    // 2. Get Disk Usage - try cache first for remote roots
    this.loadDiskUsage(remoteName, path, isLocal, item);

    // 3. Load supported hashes (for both files and directories)
    this.loadSupportedHashes();

    // 4. Check PublicLink support (only for remote filesystems)
    if (!isLocal) {
      this.checkPublicLinkSupport();
    }
  }

  /**
   * Load disk usage - uses centralized method that handles caching
   */
  private async loadDiskUsage(
    remoteName: string,
    path: string,
    isLocal: boolean,
    item: Entry | null | undefined
  ): Promise<void> {
    try {
      // For remote roots, use centralized caching method
      if (!isLocal && (!path || path === '/')) {
        const diskUsage = await this.remoteFacadeService.getCachedOrFetchDiskUsage(
          remoteName,
          remoteName.endsWith(':') ? remoteName : `${remoteName}:`,
          'ui'
        );

        if (diskUsage) {
          this.diskUsage.set({
            total: diskUsage.total_space,
            used: diskUsage.used_space,
            free: diskUsage.free_space,
          });
        }
        this.loadingDiskUsage.set(false);
        return;
      }

      // Fall back to direct API call for subdirectories or local paths
      let diskUsageRemote = remoteName;
      let diskUsagePath = path;

      if (isLocal && !(item && item.IsDir)) {
        const lastSlashIndex = remoteName.lastIndexOf('/');
        if (lastSlashIndex === 0) {
          diskUsageRemote = '/';
        } else if (lastSlashIndex > 0) {
          diskUsageRemote = remoteName.substring(0, lastSlashIndex);
        }
        diskUsagePath = '';
      }

      const diskUsage = await this.remoteManagementService.getDiskUsage(
        diskUsageRemote,
        diskUsagePath,
        'ui'
      );
      this.diskUsage.set(diskUsage);
    } catch (err) {
      console.error('Failed to load disk usage', err);
    } finally {
      this.loadingDiskUsage.set(false);
    }
  }

  /**
   * Load supported hashes from passed fsInfo (or fetch if not available) and auto-calculate the first one
   */
  private async loadSupportedHashes(): Promise<void> {
    this.loadingHashes.set(true);
    this.hashError.set(null);

    try {
      // Use cached fsInfo from Nautilus if available, otherwise fetch
      let fsInfo = this.data.fsInfo;
      if (!fsInfo) {
        const fsRemote = this.buildFsRemote();
        fsInfo = (await this.remoteManagementService.getFsInfo(fsRemote, 'ui')) as FsInfo;
      }

      const hashes = fsInfo?.Hashes ?? [];
      this.supportedHashes.set(hashes);

      // Auto-calculate only the first hash (usually md5) for single files
      // For directories, we wait for user action (bulk op)
      const currentItem = this.item();
      const isFile = currentItem && !currentItem.IsDir;
      if (hashes.length > 0 && isFile) {
        await this.calculateHash(hashes[0]);
      }
    } catch (err) {
      console.error('Failed to load supported hashes:', err);
      this.hashError.set(this.translate.instant('fileBrowser.properties.failLoadHashes'));
    } finally {
      this.loadingHashes.set(false);
    }
  }

  /**
   * Build the correct remote identifier for rclone API calls
   * For local filesystem: use "/" as the fs identifier
   * For remotes: use "remoteName:" format
   */
  private buildFsRemote(): string {
    const { remoteName, isLocal } = this.data;
    if (isLocal) {
      return '/';
    }
    return remoteName.endsWith(':') ? remoteName : `${remoteName}:`;
  }

  /**
   * Build the full path for hash calculation
   * For local filesystem: combine remoteName (which is the directory) + item.Name
   * For remotes: use the path directly
   */
  private buildHashPath(): string {
    const { remoteName, path, isLocal } = this.data;
    if (isLocal) {
      const currentItem = this.item();
      const candidatePath = path || currentItem?.Path || currentItem?.Name || '';

      if (candidatePath.startsWith('/')) {
        return candidatePath;
      }

      if (!remoteName || remoteName === '/') {
        return candidatePath ? `/${candidatePath}` : '/';
      }

      const base = remoteName.endsWith('/') ? remoteName.slice(0, -1) : remoteName;
      return candidatePath ? `${base}/${candidatePath}` : base;
    }

    return path;
  }

  /**
   * Calculate hash for a specific hash type (on-demand)
   */
  async calculateHash(hashType: string): Promise<void> {
    if (this.fileHashes()[hashType] || this.loadingHashTypes().has(hashType)) {
      return; // Already calculated or in progress
    }

    this.loadingHashTypes.update(types => {
      const newSet = new Set(types);
      newSet.add(hashType);
      return newSet;
    });

    try {
      const fsRemote = this.buildFsRemote();
      const hashPath = this.buildHashPath();

      const result = await this.remoteManagementService.getHashsumFile(
        fsRemote,
        hashPath,
        hashType,
        'ui'
      );

      if (result.hash) {
        this.fileHashes.update(hashes => ({ ...hashes, [hashType]: result.hash }));
      }
    } catch (err) {
      console.warn(`Failed to calculate ${hashType} hash:`, err);
    } finally {
      this.loadingHashTypes.update(types => {
        const newSet = new Set(types);
        newSet.delete(hashType);
        return newSet;
      });
    }
  }

  /**
   * Copy hash value to clipboard
   */
  async copyHash(hashType: string): Promise<void> {
    const hash = this.fileHashes()[hashType];
    if (!hash) return;

    try {
      await navigator.clipboard.writeText(hash);
      this.copiedHash.set(hashType);

      // Reset copy indicator after 2 seconds
      setTimeout(() => {
        if (this.copiedHash() === hashType) {
          this.copiedHash.set(null);
        }
      }, 2000);
    } catch (err) {
      console.error('Failed to copy hash:', err);
    }
  }

  /**
   * Check if a hash type is currently being calculated
   */
  isHashLoading(hashType: string): boolean {
    return this.loadingHashTypes().has(hashType);
  }

  /**
   * Check if the remote supports PublicLink feature
   */
  private async checkPublicLinkSupport(): Promise<void> {
    try {
      // Use cached fsInfo from Nautilus if available, otherwise fetch
      let fsInfo = this.data.fsInfo;
      if (!fsInfo) {
        const fsRemote = this.buildFsRemote();
        fsInfo = (await this.remoteManagementService.getFsInfo(fsRemote)) as FsInfo;
      }
      this.supportsPublicLink.set(fsInfo?.Features?.['PublicLink'] ?? false);
    } catch (err) {
      console.warn('Failed to check PublicLink support:', err);
      this.supportsPublicLink.set(false);
    }
  }

  /**
   * Get or create a public link for the current item
   */
  async getPublicLink(): Promise<void> {
    if (this.loadingPublicLink()) return;

    this.loadingPublicLink.set(true);
    this.publicLinkError.set(null);

    try {
      const fsRemote = this.buildFsRemote();
      const path = this.data.path;

      const result = await this.remoteManagementService.getPublicLink(
        fsRemote,
        path,
        false,
        this.selectedExpiry(),
        'ui'
      );

      if (result.url) {
        this.publicLinkUrl.set(result.url);
      } else {
        this.publicLinkError.set(this.translate.instant('fileBrowser.properties.failGetLink'));
      }
    } catch (err) {
      console.error('Failed to get public link:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      this.publicLinkError.set(`${this.translate.instant('common.error')}: ${errorMessage}`);
    } finally {
      this.loadingPublicLink.set(false);
    }
  }

  /**
   * Remove the public link for the current item
   */
  async removePublicLink(): Promise<void> {
    if (this.loadingPublicLink()) return;

    this.loadingPublicLink.set(true);
    this.publicLinkError.set(null);

    try {
      const fsRemote = this.buildFsRemote();
      const path = this.data.path;

      await this.remoteManagementService.getPublicLink(fsRemote, path, true, undefined, 'ui'); // unlink = true
      this.publicLinkUrl.set(null);
    } catch (err) {
      console.error('Failed to remove public link:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      this.publicLinkError.set(
        `${this.translate.instant('fileBrowser.properties.removeLink')} ${this.translate.instant(
          'common.error'
        )}: ${errorMessage}`
      );
    } finally {
      this.loadingPublicLink.set(false);
    }
  }

  /**
   * Copy the public link to clipboard
   */
  async copyPublicLink(): Promise<void> {
    const url = this.publicLinkUrl();
    if (!url) return;

    try {
      await navigator.clipboard.writeText(url);
      this.copiedLink.set(true);

      // Reset copy indicator after 2 seconds
      setTimeout(() => {
        this.copiedLink.set(false);
      }, 2000);
    } catch {
      // Clipboard failed - log to console
      console.log('Public link:', url);
      this.publicLinkError.set(this.translate.instant('fileBrowser.properties.failCopyLink'));
    }
  }

  toggleStar(): void {
    // 1. Ensure we have a valid Entry object
    const entryToSave: Entry = this.item() ?? {
      Name: this.data.path.split('/').pop() || this.data.remoteName,
      Path: this.data.path,
      IsDir: true, // Default assumption for root/unknown types
      Size: 0,
      ModTime: new Date().toISOString(),
      ID: '',
      MimeType: 'inode/directory',
    };

    // 2. Construct the FileBrowserItem
    // NOTE: Do not mutate or append a trailing ':' here — the service will
    // normalize remote identifiers. Keep components dumb and pass raw values.
    const item: FileBrowserItem = {
      entry: entryToSave,
      meta: {
        remote: this.data.remoteName,
        isLocal: this.data.isLocal,
        remoteType: this.data.remoteType,
      },
    };

    // 3. Call simplified service
    this.nautilusService.toggleItem('starred', item);
  }

  @HostListener('keydown.escape')
  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }

  getIcon(item?: Entry | null): string {
    return this.iconService.getIconForEntry(item);
  }

  /**
   * Calculate hash for all files in the directory
   */
  async calculateBulkHash(hashType: string): Promise<void> {
    if (this.calculatingBulkHash()) return;

    this.calculatingBulkHash.set(true);
    this.bulkHashError.set(null);
    this.bulkHashResult.set(null);
    this.bulkHashType.set(hashType);

    try {
      let fsRemote = this.buildFsRemote();
      let hashPath = this.buildHashPath();

      // For local bulk hashing, we need to manually construct the full absolute path
      // and send it as 'fs' (remote), leaving 'path' empty.
      // This avoids backend string concatenation issues (e.g. missing slashes or double slashes)
      if (this.data.isLocal) {
        // If hashPath is absolute (starts with /), use it directly
        // Otherwise, join remoteName (base) and hashPath
        fsRemote = hashPath.startsWith('/')
          ? hashPath
          : `${this.data.remoteName.endsWith('/') ? this.data.remoteName : this.data.remoteName + '/'}${hashPath}`;

        // Clear hashPath so backend doesn't append it
        hashPath = '';
      }

      // For directories, we use getHashsum (bulk)
      const result = await this.remoteManagementService.getHashsum(
        fsRemote,
        hashPath,
        hashType,
        'ui'
      );

      if (result.hashsum && Array.isArray(result.hashsum)) {
        this.bulkHashResult.set(result.hashsum.join('\n'));
      } else {
        this.bulkHashError.set(this.translate.instant('fileBrowser.properties.noHashesFound'));
      }
    } catch (err) {
      console.error('Failed to calculate bulk hash:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      this.bulkHashError.set(`${this.translate.instant('common.error')}: ${errorMessage}`);
    } finally {
      this.calculatingBulkHash.set(false);
    }
  }

  /**
   * Copy the generated bulk hashsum to clipboard
   */
  async copyBulkHash(): Promise<void> {
    const result = this.bulkHashResult();
    if (!result) return;

    try {
      await navigator.clipboard.writeText(result);
      this.copiedHash.set('bulk');

      setTimeout(() => {
        if (this.copiedHash() === 'bulk') {
          this.copiedHash.set(null);
        }
      }, 2000);
    } catch (err) {
      console.error('Failed to copy bulk hash:', err);
      this.notificationService.showError(this.translate.instant('common.error'));
    }
  }
}

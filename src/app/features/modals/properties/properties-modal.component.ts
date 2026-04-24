import {
  Component,
  HostListener,
  OnInit,
  OnDestroy,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
  DestroyRef,
} from '@angular/core';
import { UpperCasePipe, DecimalPipe, DatePipe } from '@angular/common';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import {
  RemoteFileOperationsService,
  NautilusService,
  RemoteFacadeService,
  ModalService,
  IconService,
  RemoteMetadataService,
  PathSelectionService,
  JobManagementService,
} from '@app/services';
import { CopyToClipboardDirective } from '@app/directives';
import { Entry, FileBrowserItem, RemoteFeatures } from '@app/types';
import { FormatFileSizePipe } from '@app/pipes';
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
    MatDialogModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
    MatTooltipModule,
    MatSelectModule,
    MatFormFieldModule,
    FormatFileSizePipe,
    TranslateModule,
    CopyToClipboardDirective,
  ],
  templateUrl: './properties-modal.component.html',
  styleUrls: ['./properties-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PropertiesModalComponent implements OnInit, OnDestroy {
  private dialogRef = inject(MatDialogRef<PropertiesModalComponent>);
  public data: {
    remoteName: string;
    path: string;
    isLocal: boolean;
    item?: Entry | null;
    remoteType?: string;
    /** Simplified features from Nautilus (avoids duplicate API calls) */
    features?: RemoteFeatures | null;
  } = inject(MAT_DIALOG_DATA);

  private readonly destroyRef = inject(DestroyRef);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly nautilusService = inject(NautilusService);
  private readonly remoteFacadeService = inject(RemoteFacadeService);
  private readonly iconService = inject(IconService);
  private readonly translate = inject(TranslateService);
  private readonly modalService = inject(ModalService);
  private readonly remoteMetadata = inject(RemoteMetadataService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly readJobGroup = `filemanager/properties/${this.data.remoteName}/${this.data.path || '/'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // Derived properties (pure data derivations)
  readonly displayLocation: string = this.data.isLocal
    ? this.data.remoteName
    : `${this.data.remoteName}${this.data.remoteName.endsWith(':') ? '' : ':'}${this.data.path}`;

  readonly fsRemote: string = this.data.isLocal
    ? '/'
    : this.data.remoteName.endsWith(':')
      ? this.data.remoteName
      : `${this.data.remoteName}:`;

  readonly hashPath: string = ((): string => {
    const { remoteName, path, isLocal, item } = this.data;
    if (isLocal) {
      const candidatePath = path || item?.Path || item?.Name || '';
      if (candidatePath.startsWith('/')) return candidatePath;
      if (!remoteName || remoteName === '/') return candidatePath ? `/${candidatePath}` : '/';
      const base = remoteName.endsWith('/') ? remoteName.slice(0, -1) : remoteName;
      return candidatePath ? `${base}/${candidatePath}` : base;
    }
    return path;
  })();

  // Separate loading states
  readonly loadingStat = signal(true);
  readonly loadingSize = signal(false);
  readonly loadingDiskUsage = signal(true);
  readonly loadingHashes = signal(false);

  readonly item = signal<Entry | null>(null);
  readonly size = signal<{ count: number; bytes: number } | null>(null);
  readonly diskUsage = signal<{ total?: number; used?: number; free?: number } | null>(null);

  // Hash related state
  readonly supportedHashes = signal<string[]>([]);
  readonly fileHashes = signal<Record<string, string>>({});
  readonly loadingHashTypes = signal<Set<string>>(new Set()); // Track which hash types are currently loading
  readonly hashError = signal<string | null>(null);
  readonly copiedHash = signal<string | null>(null); // Track which hash was just copied
  readonly copiedBulkHash = signal(false); // Track if bulk hash was copied

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

    const currentItem = this.item();
    const targetIsDir = currentItem ? !!currentItem.IsDir : true;

    // 1. Get Size/Count (if directory)
    if (targetIsDir) {
      this.loadingSize.set(true);
      this.remoteOps
        .getSize(remoteName, path, 'filemanager', this.readJobGroup)
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
    }

    // 2. Get Disk Usage - try cache first for remote roots
    this.loadDiskUsage(remoteName, path, isLocal, item);

    // 3. Load remote features (hashes, public links, etc.)
    this.loadRemoteFeatures();
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
          'filemanager',
          this.readJobGroup
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

      const diskUsage = await this.remoteOps.getDiskUsage(
        diskUsageRemote,
        diskUsagePath,
        'filemanager',
        this.readJobGroup
      );
      this.diskUsage.set(diskUsage);
    } catch (err) {
      console.error('Failed to load disk usage', err);
    } finally {
      this.loadingDiskUsage.set(false);
    }
  }

  /**
   * Load remote features (supported hashes and special capabilities like public links)
   */
  private async loadRemoteFeatures(): Promise<void> {
    const { remoteName, isLocal } = this.data;

    this.loadingHashes.set(true);
    this.hashError.set(null);

    try {
      let features = this.data.features;
      const baseName = this.pathSelectionService.normalizeRemoteName(remoteName);

      // If features were not passed, or they have no hashes (could be stub or not yet loaded in facade)
      if (!features || !features.hashes || features.hashes.length === 0) {
        this.remoteMetadata.clearCache(baseName); // Clear cache to ensure fresh fetch
        features = await this.remoteMetadata.getFeatures(baseName, 'filemanager');
      }

      // Update supported hashes
      const hashes = features?.hashes ?? [];
      this.supportedHashes.set(hashes);

      // Update public link support (only for remotes)
      if (!isLocal) {
        this.supportsPublicLink.set(features?.hasPublicLink ?? false);
      }

      // Auto-calculate only the first hash (usually md5) for single files
      const currentItem = this.item();
      const isFile = currentItem && !currentItem.IsDir;
      if (hashes.length > 0 && isFile) {
        await this.calculateHash(hashes[0]);
      }
    } catch (err) {
      console.error('Failed to load remote features:', err);
      this.hashError.set(this.translate.instant('fileBrowser.properties.failLoadHashes'));
    } finally {
      this.loadingHashes.set(false);
    }
  }

  /**
   * Helper to handle copy reset logic with memory safety
   */
  private startCopyReset(resetFn: () => void): void {
    const id = setTimeout(resetFn, 2000);
    this.destroyRef.onDestroy(() => clearTimeout(id));
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
      const result = await this.remoteOps.getHashsumFile(
        this.fsRemote,
        this.hashPath,
        hashType,
        'filemanager',
        this.readJobGroup
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
   * Check if a hash type is currently being calculated
   */
  isHashLoading(hashType: string): boolean {
    return this.loadingHashTypes().has(hashType);
  }

  /**
   * Get or create a public link for the current item
   */
  async getPublicLink(): Promise<void> {
    if (this.loadingPublicLink()) return;

    this.loadingPublicLink.set(true);
    this.publicLinkError.set(null);

    try {
      const result = await this.remoteOps.getPublicLink(
        this.fsRemote,
        this.data.path,
        false,
        this.selectedExpiry() || undefined,
        'filemanager',
        this.readJobGroup
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
      await this.remoteOps.getPublicLink(
        this.fsRemote,
        this.data.path,
        true,
        undefined,
        'filemanager',
        this.readJobGroup
      ); // unlink = true
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

  toggleStar(): void {
    const item: FileBrowserItem = {
      entry: this.getEffectiveItem(),
      meta: {
        remote: this.data.remoteName,
        isLocal: this.data.isLocal,
        remoteType: this.data.remoteType,
      },
    };

    this.nautilusService.toggleItem('starred', item);
  }

  private getEffectiveItem(): Entry {
    return (
      this.item() ?? {
        Name: this.data.path.split('/').pop() || this.data.remoteName,
        Path: this.data.path,
        IsDir: true,
        Size: 0,
        ModTime: new Date().toISOString(),
        ID: '',
        MimeType: 'inode/directory',
      }
    );
  }

  ngOnDestroy(): void {
    void this.stopReadJobs();
  }

  private async stopReadJobs(): Promise<void> {
    try {
      await this.jobManagementService.stopJobsByGroup(this.readJobGroup);
    } catch (err) {
      console.debug('Failed to stop properties read jobs:', err);
    }
  }

  @HostListener('keydown.escape')
  close(): void {
    void this.stopReadJobs();
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
      let fsRemote = this.fsRemote;
      let hashPath = this.hashPath;

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
      const result = await this.remoteOps.getHashsum(
        fsRemote,
        hashPath,
        hashType,
        'filemanager',
        this.readJobGroup
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
}

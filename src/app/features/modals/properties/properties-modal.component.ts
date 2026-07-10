import {
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
  DestroyRef,
} from '@angular/core';
import { UpperCasePipe, DecimalPipe, DatePipe } from '@angular/common';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { CopyToClipboardDirective } from '../../../shared/directives/copy-to-clipboard.directive';
import { Entry, FileBrowserItem, RemoteFeatures, ExpiryOption } from '@app/types';
import { FormatFileSizePipe } from '@app/pipes';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-properties-modal',
  imports: [
    UpperCasePipe,
    DecimalPipe,
    DatePipe,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
    MatTooltipModule,
    MatSelectModule,
    MatFormFieldModule,
    FormatFileSizePipe,
    TranslatePipe,
    CopyToClipboardDirective,
  ],
  templateUrl: './properties-modal.component.html',
  styleUrls: ['./properties-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PropertiesModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<PropertiesModalComponent>);
  public readonly data: {
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
  private readonly remoteService = inject(RemoteManagementService);
  private readonly pathService = inject(PathService);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly readJobGroup = `filemanager/properties/${this.data.remoteName}/${this.data.path || '/'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  constructor() {
    this.destroyRef.onDestroy(() => {
      void this.stopReadJobs();
    });
  }

  // Derived properties (pure data derivations)
  readonly displayLocation: string = this.pathService.getFullDisplayPath(
    { name: this.data.remoteName, isLocal: this.data.isLocal } as any,
    this.data.path
  );

  readonly fsRemote: string = this.data.isLocal
    ? '/'
    : this.pathService.normalizeRemoteForRclone(this.data.remoteName);

  readonly hashPath: string = this.data.isLocal
    ? this.pathService.joinPath(
        this.data.remoteName,
        this.data.path || this.data.item?.Path || this.data.item?.Name || ''
      )
    : this.data.path;

  // Separate loading states
  readonly loadingStat = signal(false);
  readonly loadingSize = signal(false);
  readonly loadingDiskUsage = signal(true);
  readonly loadingHashes = signal(false);

  readonly item = signal<Entry | null>(this.data.item ?? null);
  readonly size = signal<{ count: number; bytes: number } | null>(null);
  readonly diskUsage = signal<{ total?: number; used?: number; free?: number } | null>(null);

  // Hash related state
  readonly supportedHashes = signal<string[]>([]);
  readonly fileHashes = signal<Record<string, string>>({});
  readonly loadingHashTypes = signal<Set<string>>(new Set()); // Track which hash types are currently loading
  readonly hashError = signal<string | null>(null);

  // Public Link state
  readonly supportsPublicLink = signal(false);
  readonly publicLinkUrl = signal<string | null>(null);
  readonly loadingPublicLink = signal(false);
  readonly publicLinkError = signal<string | null>(null);
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
    const { remoteName, path, isLocal } = this.data;

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
    this.loadDiskUsage(remoteName, path, isLocal);

    // 3. Load remote features (hashes, public links, etc.)
    this.loadRemoteFeatures();
  }

  private async loadDiskUsage(remoteName: string, path: string, isLocal: boolean): Promise<void> {
    try {
      // For remote paths, use centralized caching method on the remote root
      if (!isLocal) {
        const diskUsage = await this.remoteFacadeService.getCachedOrFetchDiskUsage(
          remoteName,
          this.pathService.normalizeRemoteForRclone(remoteName),
          'filemanager',
          this.readJobGroup
        );

        if (diskUsage) {
          this.diskUsage.set(diskUsage);
        }
        return;
      }

      // Fall back to direct API call for local paths (resolved by backend if it's a file)
      const diskUsage = await this.remoteOps.getDiskUsage(
        remoteName,
        path,
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

  private async loadRemoteFeatures(): Promise<void> {
    const { remoteName } = this.data;

    this.loadingHashes.set(true);
    this.hashError.set(null);

    try {
      let features = this.data.features;
      const baseName = this.pathService.normalizeRemoteName(remoteName);

      // If features were not passed, or they have no hashes (could be stub or not yet loaded in facade)
      if (!features || !features.Hashes || features.Hashes.length === 0) {
        features = await this.remoteService.getFeatures(
          baseName,
          this.data.remoteType,
          'filemanager'
        );
      }

      // Update supported hashes
      const hashes = features?.Hashes ?? [];
      this.supportedHashes.set(hashes);

      this.supportsPublicLink.set(!!features?.PublicLink);

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
      const errorMessage = err instanceof Error ? err.message : String(err);
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
      const errorMessage = err instanceof Error ? err.message : String(err);
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
      entry: this.item() ?? {
        Name: this.pathService.extractName(this.data.path, this.data.remoteName),
        Path: this.data.path,
        IsDir: true,
        Size: 0,
        ModTime: new Date().toISOString(),
        ID: '',
        MimeType: 'inode/directory',
      },
      meta: {
        remote: this.data.remoteName,
        isLocal: this.data.isLocal,
        remoteType: this.data.remoteType,
      },
    };

    this.nautilusService.toggleItem('starred', item);
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
    this.dialogRef.close();
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
      if (this.data.isLocal) {
        fsRemote = this.pathService.isLocalPath(hashPath)
          ? hashPath
          : this.pathService.joinPath(this.data.remoteName, hashPath);

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
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.bulkHashError.set(`${this.translate.instant('common.error')}: ${errorMessage}`);
    } finally {
      this.calculatingBulkHash.set(false);
    }
  }
}

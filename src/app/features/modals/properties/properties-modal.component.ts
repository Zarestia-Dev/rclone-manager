import * as pathUtils from 'src/app/shared/utils/path.utils';
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
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { RemoteFileOperationsService } from '../../../services/remote/remote-file-operations.service';
import { NautilusService } from '../../../services/ui/nautilus.service';
import { RemoteDiskUsageService } from '../../../services/remote/remote-disk-usage.service';
import { IconService } from '../../../services/ui/icon.service';
import { RemoteManagementService } from '../../../services/remote/remote-management.service';
import { PathService } from '../../../services/infrastructure/platform/path.service';
import { JobManagementService } from '../../../services/operations/job-management.service';
import { CopyToClipboardDirective } from '../../../shared/directives/copy-to-clipboard.directive';
import { Entry, FileBrowserItem, RemoteFeatures, ExpiryOption } from '@app/types';
import { FormatFileSizePipe } from '@app/pipes';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { generatePrefixedId, getShareInfo, ItemShareInfo } from '../../../shared/utils';

@Component({
  selector: 'app-properties-modal',
  imports: [
    UpperCasePipe,
    DecimalPipe,
    DatePipe,
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
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
  private readonly capacity = inject(RemoteDiskUsageService);
  protected readonly iconService = inject(IconService);
  private readonly translate = inject(TranslateService);
  private readonly remoteService = inject(RemoteManagementService);
  private readonly pathService = inject(PathService);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly readJobGroup = generatePrefixedId('filemanager/properties');

  constructor() {
    this.destroyRef.onDestroy(() => {
      void this.stopReadJobs();
    });
  }

  // Derived properties (pure data derivations)
  readonly fsRemote: string = this.data.isLocal
    ? this.data.remoteName
    : this.pathService.normalizeRemoteForRclone(this.data.remoteName);

  readonly hashPath: string = this.data.isLocal
    ? this.data.path ||
      this.data.item?.Path ||
      (this.data.item?.IsDir ? '' : this.data.item?.Name) ||
      ''
    : this.data.path;

  readonly displayLocation: string = this.pathService.getFullDisplayPath(
    { name: this.data.remoteName, isLocal: this.data.isLocal },
    this.hashPath
  );

  // Separate loading states
  readonly loadingStat = signal(false);
  readonly loadingSize = signal(false);
  readonly loadingDiskUsage = signal(true);
  readonly loadingHashes = signal(false);

  readonly item = signal<Entry | null>(this.data.item ?? null);
  readonly shareInfo = computed<ItemShareInfo>(() =>
    getShareInfo(this.item(), this.data.remoteType, this.data.remoteName)
  );
  readonly size = signal<{ count: number; bytes: number } | null>(null);
  readonly diskUsage = signal<{ total?: number; used?: number; free?: number } | null>(null);

  // Metadata overlay state
  readonly showMetadataOverlay = signal(false);
  readonly loadingMetadata = signal(true);
  readonly metadataEntries = computed<{ key: string; value: string }[]>(() => {
    const md = this.item()?.Metadata;
    if (!md) return [];

    return Object.entries(md)
      .filter(([_, val]) => val !== undefined && val !== null && val !== '')
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => a.key.localeCompare(b.key));
  });

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
    this.nautilusService.isSaved('starred', this.data.remoteName, this.hashPath)
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
    const stat = this.loadStat();
    void this.loadSize(stat);
    void this.loadDiskUsage();
    void this.loadRemoteFeatures(stat);
  }

  private async loadSize(stat: Promise<void>): Promise<void> {
    this.loadingSize.set(true);
    try {
      if (!this.item()) await stat;
      const item = this.item();
      if (!item || this.destroyRef.destroyed) return;
      const size = !item.IsDir
        ? { count: 1, bytes: item.Size }
        : await this.remoteOps.getSize(
            this.fsRemote,
            this.hashPath,
            'filemanager',
            this.readJobGroup
          );
      this.size.set(size);
    } catch (err) {
      console.error('Failed to load size', err);
    } finally {
      this.loadingSize.set(false);
    }
  }

  private async loadStat(): Promise<void> {
    const hasInitialItem = Boolean(this.item());
    if (!hasInitialItem) {
      this.loadingStat.set(true);
    }
    this.loadingMetadata.set(true);
    try {
      const res = await this.remoteOps.getStat(
        this.fsRemote,
        this.hashPath,
        { metadata: true },
        'filemanager',
        this.readJobGroup
      );
      if (res?.item) {
        this.item.set(res.item);
        if (!res.item.IsDir && this.size() === null) {
          this.size.set({ count: 1, bytes: res.item.Size });
        }
      }
    } catch (err) {
      console.debug('Failed to getStat with metadata:', err);
    } finally {
      this.loadingStat.set(false);
      this.loadingMetadata.set(false);
    }
  }

  private async loadDiskUsage(): Promise<void> {
    try {
      const diskUsage = this.data.isLocal
        ? await this.remoteOps.getDiskUsage(
            this.fsRemote,
            this.hashPath,
            'filemanager',
            this.readJobGroup
          )
        : await this.capacity.load(this.data.remoteName, {
            source: 'filemanager',
            group: this.readJobGroup,
          });
      if (diskUsage) {
        this.diskUsage.set(diskUsage);
      }
    } catch (err) {
      console.error('Failed to load disk usage', err);
    } finally {
      this.loadingDiskUsage.set(false);
    }
  }

  private async loadRemoteFeatures(stat: Promise<void>): Promise<void> {
    const { remoteName } = this.data;

    this.loadingHashes.set(true);
    this.hashError.set(null);

    try {
      let features = this.data.features;
      const baseName = this.pathService.normalizeRemoteName(remoteName);

      // If features were not passed, or they have no hashes (could be stub or not yet loaded in facade)
      if (!features || !features.Hashes || features.Hashes.length === 0) {
        features = await this.remoteService.getFeatures(baseName, {
          source: 'filemanager',
          group: this.readJobGroup,
        });
      }

      // Update supported hashes
      const hashes = features?.Hashes ?? [];
      this.supportedHashes.set(hashes);

      this.supportsPublicLink.set(!!features?.PublicLink);

      await stat;
      // Auto-calculate only the first hash (usually md5) for single files
      if (!this.destroyRef.destroyed && hashes.length > 0 && this.isFile()) {
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
      entry: {
        ...(this.item() ?? {
          Name: pathUtils.extractName(this.hashPath, this.data.remoteName),
          IsDir: true,
          Size: 0,
          ModTime: new Date().toISOString(),
          ID: '',
          MimeType: 'inode/directory',
        }),
        Path: this.hashPath,
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
    if (this.showMetadataOverlay()) {
      this.showMetadataOverlay.set(false);
      return;
    }
    this.dialogRef.close();
  }

  closeModal(): void {
    this.dialogRef.close();
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
      // For directories, we use getHashsum (bulk)
      const result = await this.remoteOps.getHashsum(
        this.fsRemote,
        this.hashPath,
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

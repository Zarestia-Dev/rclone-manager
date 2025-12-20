import { Component, HostListener, OnInit, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
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
import { RemoteManagementService, NautilusService } from '@app/services';
import { Entry, FileBrowserItem, FsInfo } from '@app/types';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';
import { IconService } from 'src/app/shared/services/icon.service';

interface ExpiryOption {
  value: string;
  label: string;
}

@Component({
  selector: 'app-properties-modal',
  standalone: true,
  imports: [
    CommonModule,
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
  ],
  templateUrl: './properties-modal.component.html',
  styleUrls: ['./properties-modal.component.scss', '../../../../styles/_shared-modal.scss'],
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
  private iconService = inject(IconService);

  // Separate loading states
  loadingStat = true;
  loadingSize = true;
  loadingDiskUsage = true;
  loadingHashes = false;

  item: Entry | null = null;
  size: { count: number; bytes: number } | null = null;
  diskUsage: { total?: number; used?: number; free?: number } | null = null;
  displayLocation = '';

  // Hash related state
  supportedHashes: string[] = [];
  fileHashes: Record<string, string> = {};
  loadingHashTypes = new Set<string>(); // Track which hash types are currently loading
  hashError: string | null = null;
  copiedHash: string | null = null; // Track which hash was just copied

  // Public Link state
  supportsPublicLink = false;
  publicLinkUrl: string | null = null;
  loadingPublicLink = false;
  publicLinkError: string | null = null;
  copiedLink = false;
  selectedExpiry = ''; // Empty = no expiry

  // Expiry options for public links
  readonly expiryOptions: ExpiryOption[] = [
    { value: '', label: 'Never' },
    { value: '1h', label: '1 Hour' },
    { value: '1d', label: '1 Day' },
    { value: '7d', label: '7 Days' },
    { value: '30d', label: '30 Days' },
  ];

  // Reactive Star State derived from Service
  isStarred = computed(() =>
    this.nautilusService.isSaved('starred', this.data.remoteName, this.data.path)
  );

  ngOnInit(): void {
    const { remoteName, path, isLocal, item } = this.data;

    // Set the item immediately
    this.item = item ?? null;
    this.loadingStat = false;

    // Construct the display location string
    if (isLocal) {
      this.displayLocation = remoteName;
    } else {
      const sep = remoteName && !remoteName.endsWith(':') ? ':' : '';
      this.displayLocation = `${remoteName}${sep}${path}`;
    }

    const targetIsDir = this.item ? !!this.item.IsDir : true;

    // 1. Get Size/Count (if directory)
    if (targetIsDir) {
      this.remoteManagementService
        .getSize(remoteName, path)
        .then(size => {
          this.size = size;
          this.loadingSize = false;
        })
        .catch(err => {
          console.error('Failed to load size', err);
          this.loadingSize = false;
        });
    } else if (this.item) {
      this.size = { count: 1, bytes: this.item.Size };
      this.loadingSize = false;
    } else {
      this.loadingSize = false;
    }

    // 2. Get Disk Usage
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
    this.remoteManagementService
      .getDiskUsage(diskUsageRemote, diskUsagePath)
      .then(diskUsage => {
        this.diskUsage = diskUsage;
        this.loadingDiskUsage = false;
      })
      .catch(err => {
        console.error('Failed to load disk usage', err);
        this.loadingDiskUsage = false;
      });

    // 3. Load supported hashes (only for files, not directories)
    if (!targetIsDir && this.item) {
      this.loadSupportedHashes();
    }

    // 4. Check PublicLink support (only for remote filesystems)
    if (!isLocal) {
      this.checkPublicLinkSupport();
    }
  }

  /**
   * Load supported hashes from passed fsInfo (or fetch if not available) and auto-calculate the first one
   */
  private async loadSupportedHashes(): Promise<void> {
    this.loadingHashes = true;
    this.hashError = null;

    try {
      // Use cached fsInfo from Nautilus if available, otherwise fetch
      let fsInfo = this.data.fsInfo;
      if (!fsInfo) {
        const fsRemote = this.buildFsRemote();
        fsInfo = (await this.remoteManagementService.getFsInfo(fsRemote)) as FsInfo;
      }

      this.supportedHashes = fsInfo?.Hashes ?? [];

      // Auto-calculate only the first hash (usually md5)
      if (this.supportedHashes.length > 0) {
        await this.calculateHash(this.supportedHashes[0]);
      }
    } catch (err) {
      console.error('Failed to load supported hashes:', err);
      this.hashError = 'Failed to load checksums';
    } finally {
      this.loadingHashes = false;
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
    if (isLocal && this.item) {
      // For local files, remoteName is the directory path, and we need the full path
      const dir = remoteName.endsWith('/') ? remoteName : `${remoteName}/`;
      return `${dir}${this.item.Name}`;
    }
    return path;
  }

  /**
   * Calculate hash for a specific hash type (on-demand)
   */
  async calculateHash(hashType: string): Promise<void> {
    if (this.fileHashes[hashType] || this.loadingHashTypes.has(hashType)) {
      return; // Already calculated or in progress
    }

    this.loadingHashTypes.add(hashType);

    try {
      const fsRemote = this.buildFsRemote();
      const hashPath = this.buildHashPath();

      const result = await this.remoteManagementService.getHashsum(fsRemote, hashPath, hashType);

      if (result.hashsum && result.hashsum.length > 0) {
        // Extract just the hash part (before the spaces and filename)
        const hashLine = result.hashsum[0];
        const hash = hashLine.split(/\s{2}/)[0]; // Split on double space
        this.fileHashes[hashType] = hash;
      }
    } catch (err) {
      console.warn(`Failed to calculate ${hashType} hash:`, err);
    } finally {
      this.loadingHashTypes.delete(hashType);
    }
  }

  /**
   * Copy hash value to clipboard
   */
  async copyHash(hashType: string): Promise<void> {
    const hash = this.fileHashes[hashType];
    if (!hash) return;

    try {
      await navigator.clipboard.writeText(hash);
      this.copiedHash = hashType;

      // Reset copy indicator after 2 seconds
      setTimeout(() => {
        if (this.copiedHash === hashType) {
          this.copiedHash = null;
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
    return this.loadingHashTypes.has(hashType);
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
      this.supportsPublicLink = fsInfo?.Features?.['PublicLink'] ?? false;
    } catch (err) {
      console.warn('Failed to check PublicLink support:', err);
      this.supportsPublicLink = false;
    }
  }

  /**
   * Get or create a public link for the current item
   */
  async getPublicLink(): Promise<void> {
    if (this.loadingPublicLink) return;

    this.loadingPublicLink = true;
    this.publicLinkError = null;

    try {
      const fsRemote = this.buildFsRemote();
      const path = this.data.path;

      const result = await this.remoteManagementService.getPublicLink(
        fsRemote,
        path,
        false,
        this.selectedExpiry
      );

      if (result.url) {
        this.publicLinkUrl = result.url;
      } else {
        this.publicLinkError = 'Failed to get public link';
      }
    } catch (err) {
      console.error('Failed to get public link:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      this.publicLinkError = `Failed: ${errorMessage}`;
    } finally {
      this.loadingPublicLink = false;
    }
  }

  /**
   * Remove the public link for the current item
   */
  async removePublicLink(): Promise<void> {
    if (this.loadingPublicLink) return;

    this.loadingPublicLink = true;
    this.publicLinkError = null;

    try {
      const fsRemote = this.buildFsRemote();
      const path = this.data.path;

      await this.remoteManagementService.getPublicLink(fsRemote, path, true); // unlink = true
      this.publicLinkUrl = null;
    } catch (err) {
      console.error('Failed to remove public link:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      this.publicLinkError = `Failed to remove: ${errorMessage}`;
    } finally {
      this.loadingPublicLink = false;
    }
  }

  /**
   * Copy the public link to clipboard
   */
  async copyPublicLink(): Promise<void> {
    if (!this.publicLinkUrl) return;

    try {
      await navigator.clipboard.writeText(this.publicLinkUrl);
      this.copiedLink = true;

      // Reset copy indicator after 2 seconds
      setTimeout(() => {
        this.copiedLink = false;
      }, 2000);
    } catch {
      // Clipboard failed - log to console
      console.log('Public link:', this.publicLinkUrl);
      this.publicLinkError = 'Failed to copy - check console';
    }
  }

  toggleStar(): void {
    // 1. Ensure we have a valid Entry object
    const entryToSave: Entry = this.item ?? {
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
    this.dialogRef.close();
  }

  getIcon(item?: Entry | null): string {
    if (!item) return 'folder';
    if (item.IsDir) return 'folder';
    return this.iconService.getIconForFileType(item.Name);
  }

  /** Get hash entries as array for template iteration */
  get hashEntries(): { type: string; value: string }[] {
    return Object.entries(this.fileHashes).map(([type, value]) => ({ type, value }));
  }

  /** Get uncalculated hash types */
  get uncalculatedHashes(): string[] {
    return this.supportedHashes.filter(h => !this.fileHashes[h]);
  }

  /** Check if file has any hashes calculated */
  get hasHashes(): boolean {
    return Object.keys(this.fileHashes).length > 0;
  }

  /** Check if this is a file (not directory) */
  get isFile(): boolean {
    return this.item !== null && !this.item.IsDir;
  }
}

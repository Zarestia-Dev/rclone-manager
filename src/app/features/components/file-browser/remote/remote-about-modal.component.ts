import { CommonModule } from '@angular/common';
import { Component, HostListener, inject, OnInit, signal } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatCardModule } from '@angular/material/card';
import { RemoteManagementService, RemoteFacadeService } from 'src/app/services';
import { IconService } from '@app/services';
import { FormatFileSizePipe } from 'src/app/shared/pipes';

interface RemoteAboutData {
  remote: { displayName: string; normalizedName: string; type?: string };
}

@Component({
  selector: 'app-remote-about-modal',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatDividerModule,
    MatIconModule,
    MatButtonModule,
    MatTabsModule,
    MatChipsModule,
    MatExpansionModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatCardModule,
    FormatFileSizePipe,
  ],
  templateUrl: './remote-about-modal.component.html',
  styleUrls: ['./remote-about-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class RemoteAboutModalComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<RemoteAboutModalComponent>);
  private remoteManagementService = inject(RemoteManagementService);
  private remoteFacadeService = inject(RemoteFacadeService);
  public iconService = inject(IconService);
  public data: RemoteAboutData = inject(MAT_DIALOG_DATA);

  // Independent Signals for separate loading states
  aboutInfo = signal<Record<string, unknown> | null>(null);
  remoteType = signal<string>('');
  remoteName = signal<string>('');
  sizeInfo = signal<{ count: number; bytes: number } | null>(null);
  diskUsageInfo = signal<{ total?: number; used?: number; free?: number } | null>(null);

  loadingAbout = signal(true);
  loadingSize = signal(true);
  loadingUsage = signal(true);

  errorAbout = signal<string | null>(null);

  ngOnInit(): void {
    this.remoteType.set(this.data.remote.type || 'Unknown');
    this.remoteName.set(this.data.remote.normalizedName);
    this.loadDataSeparately();
  }

  /**
   * Initiates separate async requests for data.
   * Allows the UI to show partial data as it arrives.
   */
  loadDataSeparately(): void {
    // 1. Load FS Info & Check for 'About' feature support
    this.loadingAbout.set(true);
    this.loadingUsage.set(true);
    this.remoteManagementService
      .getFsInfo(this.remoteName())
      .then(info => {
        const typedInfo = info as Record<string, any>;
        this.aboutInfo.set(typedInfo);
        this.loadingAbout.set(false);

        // Check if 'About' feature is supported before fetching usage
        const features = typedInfo['Features'] as Record<string, boolean>;
        if (features && features['About']) {
          this.fetchDiskUsage();
        } else {
          // Feature not supported, skip disk usage fetch
          this.loadingUsage.set(false);
          this.diskUsageInfo.set(null);
        }
      })
      .catch(err => {
        console.error('Error loading fs info:', err);
        this.errorAbout.set('Failed to load remote information.');
        this.loadingAbout.set(false);
        this.loadingUsage.set(false);
      });

    // 3. Load Size/Count (Slowest, can take time for large remotes)
    this.loadingSize.set(true);
    this.remoteManagementService
      .getSize(this.remoteName())
      .then(size => {
        this.sizeInfo.set(size);
        this.loadingSize.set(false);
      })
      .catch(err => {
        console.warn('Size check failed:', err);
        this.loadingSize.set(false);
      });
  }

  private async fetchDiskUsage(): Promise<void> {
    try {
      // Use centralized method that handles caching and fetching
      const diskUsage = await this.remoteFacadeService.getCachedOrFetchDiskUsage(
        this.data.remote.displayName,
        this.remoteName()
      );

      if (diskUsage) {
        this.diskUsageInfo.set({
          total: diskUsage.total_space,
          used: diskUsage.used_space,
          free: diskUsage.free_space,
        });
      } else {
        this.diskUsageInfo.set(null);
      }
    } catch (err) {
      console.warn('Disk usage check failed:', err);
      this.diskUsageInfo.set(null);
    } finally {
      this.loadingUsage.set(false);
    }
  }

  // --- Helpers for Template ---

  getRoot(about: any): string {
    return (about?.['Root'] as string) || '/';
  }

  getPrecisionFormatted(about: any): string {
    const ns = about?.['Precision'] as number;
    if (!ns) return '-';
    if (ns >= 1000000000) return ns / 1000000000 + ' s';
    if (ns >= 1000000) return ns / 1000000 + ' ms';
    if (ns >= 1000) return ns / 1000 + ' µs';
    return ns + ' ns';
  }

  getHashes(about: any): string[] {
    const h = about?.['Hashes'];
    return Array.isArray(h) ? h : [];
  }

  getFeatures(about: any): { key: string; value: boolean }[] {
    const features = about?.['Features'];
    if (!features) return [];
    return Object.entries(features)
      .map(([key, value]) => ({ key, value: !!value }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  getMetadataGroups(about: any): {
    name: string;
    items: { key: string; data: Record<string, unknown> }[];
  }[] {
    const info = about?.['MetadataInfo'] as Record<string, unknown>;
    if (!info) return [];

    const groups = [];

    // 1. System Metadata
    if (info['System']) {
      const sysItems = Object.entries(info['System'] as Record<string, unknown>)
        .map(([key, data]) => ({ key, data: data as Record<string, unknown> }))
        .sort((a, b) => a.key.localeCompare(b.key));

      if (sysItems.length) {
        groups.push({ name: 'System Metadata', items: sysItems });
      }
    }

    // 2. User/Other Metadata
    const otherItems = Object.entries(info)
      .filter(([key, val]) => key !== 'System' && typeof val === 'object' && val !== null)
      .map(([key, data]) => ({ key, data: data as Record<string, unknown> }))
      .sort((a, b) => a.key.localeCompare(b.key));

    if (otherItems.length) {
      groups.push({ name: 'Standard Metadata', items: otherItems });
    }

    return groups;
  }

  @HostListener('window:escape')
  close(): void {
    this.dialogRef.close();
  }
}

import { DecimalPipe, TitleCasePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { IconService } from 'src/app/services/ui/icon.service';
import { RcloneValueMapperService } from 'src/app/services/remote/rclone-value-mapper.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { FormatFileSizePipe } from '@app/pipes';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { FsInfo, RemoteAboutData } from '@app/types';

export interface MetadataItem {
  Help?: string;
  Type?: string;
  ReadOnly?: boolean;
  Example?: string;
}

export interface MetadataGroup {
  id: string;
  nameKey: string;
  items: { key: string; data: MetadataItem }[];
}

@Component({
  selector: 'app-remote-about-modal',
  imports: [
    TitleCasePipe,
    DecimalPipe,
    MatIconModule,
    MatButtonModule,
    MatTabsModule,
    MatExpansionModule,
    MatCardModule,
    MatProgressBarModule,
    FormatFileSizePipe,
    TranslatePipe,
  ],
  templateUrl: './remote-about-modal.component.html',
  styleUrls: ['./remote-about-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(keydown.escape)': 'close()',
  },
})
export class RemoteAboutModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<RemoteAboutModalComponent>);
  private readonly destroyRef = inject(DestroyRef);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly remoteFacadeService = inject(RemoteFacadeService);
  private readonly remoteService = inject(RemoteManagementService);
  private readonly translate = inject(TranslateService);
  private readonly mapper = inject(RcloneValueMapperService);
  private readonly jobManagementService = inject(JobManagementService);
  public readonly iconService = inject(IconService);
  public readonly data: RemoteAboutData = inject(MAT_DIALOG_DATA);
  private readonly readJobGroup = `dashboard/remote-about/${this.data.remote.displayName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  private isDestroyed = false;

  // Plain properties — no need for a signal when value never changes
  readonly displayName = this.data.remote.displayName;
  readonly normalizedName = this.data.remote.normalizedName;

  // Signals
  readonly aboutInfo = signal<FsInfo | null>(null);
  readonly sizeInfo = signal<{ count: number; bytes: number } | null>(null);
  readonly loadingAbout = signal(true);
  readonly loadingSize = signal(true);
  readonly errorAbout = signal<string | null>(null);

  // Facade signals — direct reference, no unnecessary computed wrapper
  readonly diskUsage = this.remoteFacadeService.diskUsageSignal(this.displayName);

  readonly usedPercentage = computed(() => {
    const usage = this.diskUsage();
    if (!usage || !usage.total || usage.used === undefined) return 0;
    return Math.min(100, Math.max(0, Math.round((usage.used / usage.total) * 100)));
  });

  // Derived computed signals — strongly typed
  readonly root = computed(() => this.aboutInfo()?.Root || '/');

  readonly precision = computed(() => {
    const ns = this.aboutInfo()?.Precision;
    return ns != null ? this.mapper.nanosecondsToDuration(ns) : '-';
  });

  readonly hashes = computed<string[]>(() => {
    const h = this.aboutInfo()?.Hashes;
    return Array.isArray(h) ? h : [];
  });

  readonly features = computed<{ key: string; value: boolean }[]>(() => {
    const features = this.aboutInfo()?.Features;
    if (!features) return [];
    return Object.entries(features)
      .filter(([key]) => key !== 'IsLocal')
      .map(([key, value]) => ({ key, value: !!value }))
      .sort((a, b) => a.key.localeCompare(b.key));
  });

  readonly supportedFeaturesCount = computed(() => this.features().filter(f => f.value).length);

  readonly metadataGroups = computed<MetadataGroup[]>(() => {
    const info = this.aboutInfo()?.MetadataInfo as Record<string, unknown> | undefined;
    if (!info) return [];

    const groups: MetadataGroup[] = [];

    if (info['System']) {
      const sysItems = Object.entries(info['System'] as Record<string, MetadataItem>)
        .map(([key, data]) => ({ key, data }))
        .sort((a, b) => a.key.localeCompare(b.key));

      if (sysItems.length) {
        groups.push({
          id: 'system',
          nameKey: 'fileBrowser.remoteAbout.metadata.system',
          items: sysItems,
        });
      }
    }

    const otherItems = Object.entries(info)
      .filter(([key, val]) => key !== 'System' && typeof val === 'object' && val !== null)
      .map(([key, data]) => ({ key, data: data as MetadataItem }))
      .sort((a, b) => a.key.localeCompare(b.key));

    if (otherItems.length) {
      groups.push({
        id: 'standard',
        nameKey: 'fileBrowser.remoteAbout.metadata.standard',
        items: otherItems,
      });
    }

    return groups;
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.isDestroyed = true;
      void this.stopReadJobs();
    });
  }

  ngOnInit(): void {
    this.remoteService.clearCache(this.displayName);
    this.loadData();
  }

  async loadData(): Promise<void> {
    this.loadingAbout.set(true);
    this.loadingSize.set(true);

    // 1. Fetch FsInfo (fast) - allows the modal content to appear
    try {
      const fsInfo = await this.remoteService.getFsInfo(
        this.normalizedName,
        'dashboard',
        this.readJobGroup
      );
      if (!this.isDestroyed) {
        this.aboutInfo.set(fsInfo);
      }
    } catch (error) {
      console.error('Error loading fs info:', error);
      if (!this.isDestroyed) {
        this.errorAbout.set(
          `${this.translate.instant('fileBrowser.remoteAbout.error')} ${this.extractErrorMessage(error)}`
        );
      }
    } finally {
      if (!this.isDestroyed) {
        this.loadingAbout.set(false);
      }
    }

    // 2. Fetch both Disk Usage and Size in parallel background tasks
    this.fetchDiskUsage();
    this.loadSizeInBackground();
  }

  private async loadSizeInBackground(): Promise<void> {
    try {
      const sizeData = await this.remoteOps.getSize(
        this.normalizedName,
        undefined,
        'dashboard',
        this.readJobGroup
      );
      if (!this.isDestroyed) {
        this.sizeInfo.set(sizeData);
      }
    } catch (error) {
      console.warn('Size check failed:', error);
    } finally {
      if (!this.isDestroyed) {
        this.loadingSize.set(false);
      }
    }
  }

  async fetchDiskUsage(forceRefresh = false): Promise<void> {
    await this.remoteFacadeService.getCachedOrFetchDiskUsage(
      this.displayName,
      this.normalizedName,
      'dashboard',
      this.readJobGroup,
      forceRefresh
    );
  }

  private async stopReadJobs(): Promise<void> {
    try {
      await this.jobManagementService.stopJobsByGroup(this.readJobGroup);
    } catch (err) {
      console.debug('Failed to stop remote about read jobs:', err);
    }
  }

  private extractErrorMessage(error: unknown): string {
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    return String(error);
  }

  close(): void {
    this.dialogRef.close();
  }
}

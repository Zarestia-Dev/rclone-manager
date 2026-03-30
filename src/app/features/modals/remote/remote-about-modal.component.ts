import { TitleCasePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  IconService,
  ModalService,
  RcloneValueMapperService,
  RemoteFacadeService,
  RemoteFileOperationsService,
  RemoteMetadataService,
} from 'src/app/services';
import { FormatFileSizePipe } from 'src/app/shared/pipes';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { DiskUsage, FsInfo } from '@app/types';

interface RemoteAboutData {
  remote: { displayName: string; normalizedName: string; type?: string };
}

@Component({
  selector: 'app-remote-about-modal',
  standalone: true,
  imports: [
    TitleCasePipe,
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
    TranslateModule,
  ],
  templateUrl: './remote-about-modal.component.html',
  styleUrls: ['./remote-about-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteAboutModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<RemoteAboutModalComponent>);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly remoteFacadeService = inject(RemoteFacadeService);
  private readonly metadataService = inject(RemoteMetadataService);
  private readonly translate = inject(TranslateService);
  private readonly modalService = inject(ModalService);
  private readonly mapper = inject(RcloneValueMapperService);
  public readonly iconService = inject(IconService);
  public readonly data: RemoteAboutData = inject(MAT_DIALOG_DATA);

  // Plain properties — no need for a signal when value never changes
  readonly displayName = this.data.remote.displayName;
  readonly normalizedName = this.data.remote.normalizedName;

  // Signals
  readonly aboutInfo = signal<FsInfo | null>(null);
  readonly sizeInfo = signal<{ count: number; bytes: number } | null>(null);
  readonly loadingAbout = signal(true);
  readonly loadingSize = signal(true);
  readonly errorAbout = signal<string | null>(null);

  // Facade signals — simplified, no double-cast needed
  readonly diskUsage = computed<DiskUsage>(() =>
    this.remoteFacadeService.diskUsageSignal(this.displayName)()
  );

  // Derived computed signals — replaces template method calls
  readonly root = computed(() => (this.aboutInfo()?.['Root'] as string) || '/');

  readonly precision = computed(() => {
    const ns = this.aboutInfo()?.Precision;
    return ns != null ? this.mapper.nanosecondsToDuration(ns) : '-';
  });

  readonly hashes = computed<string[]>(() => {
    const h = this.aboutInfo()?.Hashes;
    return Array.isArray(h) ? h : [];
  });

  readonly features = computed<{ key: string; value: boolean }[]>(() => {
    const features = this.aboutInfo()?.Features as Record<string, unknown> | undefined;
    if (!features) return [];
    return Object.entries(features)
      .filter(([key]) => key !== 'IsLocal')
      .map(([key, value]) => ({ key, value: !!value }))
      .sort((a, b) => a.key.localeCompare(b.key));
  });

  readonly metadataGroups = computed(() => {
    const info = this.aboutInfo()?.MetadataInfo as Record<string, unknown> | undefined;
    if (!info) return [];

    const groups: { name: string; items: { key: string; data: Record<string, unknown> }[] }[] = [];

    if (info['System']) {
      const sysItems = Object.entries(info['System'] as Record<string, unknown>)
        .map(([key, data]) => ({ key, data: data as Record<string, unknown> }))
        .sort((a, b) => a.key.localeCompare(b.key));

      if (sysItems.length) {
        groups.push({
          name: this.translate.instant('fileBrowser.remoteAbout.metadata.system'),
          items: sysItems,
        });
      }
    }

    const otherItems = Object.entries(info)
      .filter(([key, val]) => key !== 'System' && typeof val === 'object' && val !== null)
      .map(([key, data]) => ({ key, data: data as Record<string, unknown> }))
      .sort((a, b) => a.key.localeCompare(b.key));

    if (otherItems.length) {
      groups.push({
        name: this.translate.instant('fileBrowser.remoteAbout.metadata.standard'),
        items: otherItems,
      });
    }

    return groups;
  });

  ngOnInit(): void {
    this.metadataService.clearCache(this.displayName);
    this.loadData();
  }

  async loadData(): Promise<void> {
    this.loadingAbout.set(true);
    this.loadingSize.set(true);

    // 1. Fetch FsInfo (fast) - allows the modal content to appear
    try {
      const fsInfo = await this.metadataService.getFsInfo(this.normalizedName, 'ui');
      this.aboutInfo.set(fsInfo);
    } catch (error) {
      console.error('Error loading fs info:', error);
      this.errorAbout.set(`${this.translate.instant('fileBrowser.remoteAbout.error')} ${error}`);
    } finally {
      this.loadingAbout.set(false);
    }

    // 2. Fetch both Disk Usage and Size in parallel background tasks
    this.fetchDiskUsage();
    this.loadSizeInBackground();
  }

  private async loadSizeInBackground(): Promise<void> {
    try {
      const sizeData = await this.remoteOps.getSize(this.normalizedName, undefined, 'ui');
      this.sizeInfo.set(sizeData);
    } catch (error) {
      console.warn('Size check failed:', error);
    } finally {
      this.loadingSize.set(false);
    }
  }

  async fetchDiskUsage(forceRefresh = false): Promise<void> {
    await this.remoteFacadeService.getCachedOrFetchDiskUsage(
      this.displayName,
      this.normalizedName,
      'ui',
      forceRefresh
    );
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }
}

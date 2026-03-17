import { TitleCasePipe } from '@angular/common';
import {
  Component,
  HostListener,
  inject,
  OnInit,
  signal,
  computed,
  Signal,
  ChangeDetectionStrategy,
} from '@angular/core';
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
import {
  RemoteFileOperationsService,
  RemoteFacadeService,
  ModalService,
  RemoteMetadataService,
  IconService,
  RcloneValueMapperService,
} from 'src/app/services';
import { FormatFileSizePipe } from 'src/app/shared/pipes';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { DiskUsage, RemoteFeatures, FsInfo } from '@app/types';

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
  private dialogRef = inject(MatDialogRef<RemoteAboutModalComponent>);
  private remoteOps = inject(RemoteFileOperationsService);
  private remoteFacadeService = inject(RemoteFacadeService);
  private metadataService = inject(RemoteMetadataService);
  public iconService = inject(IconService);
  private translate = inject(TranslateService);
  private modalService = inject(ModalService);
  private mapper = inject(RcloneValueMapperService);
  public data: RemoteAboutData = inject(MAT_DIALOG_DATA);

  // Independent Signals for separate loading states
  remoteName = signal<string>('');
  features = computed<RemoteFeatures>(() =>
    (
      this.remoteFacadeService.featuresSignal(
        this.data.remote.displayName
      ) as Signal<RemoteFeatures>
    )()
  );
  diskUsage = computed<DiskUsage>(() =>
    (this.remoteFacadeService.diskUsageSignal(this.data.remote.displayName) as Signal<DiskUsage>)()
  );

  // Detailed FsInfo (Metadata, Hashes, etc.)
  aboutInfo = signal<FsInfo | null>(null);
  sizeInfo = signal<{ count: number; bytes: number } | null>(null);

  loadingAbout = signal(true);
  loadingSize = signal(true);
  errorAbout = signal<string | null>(null);

  ngOnInit(): void {
    const name = this.data.remote.displayName;
    // Ensure we clear the cache for this remote when opening the about modal
    // to guarantee fresh data for the user.
    this.metadataService.clearCache(name);

    this.remoteName.set(this.data.remote.normalizedName);
    this.loadData();
  }

  /**
   * Loads detailed FsInfo and triggers background tasks if needed.
   */
  async loadData(): Promise<void> {
    const name = this.remoteName();

    // 1. Load detailed FsInfo (Metadata, Hashes, Precision, etc.)
    this.loadingAbout.set(true);
    try {
      const info = await this.metadataService.getFsInfo(name, 'ui');
      this.aboutInfo.set(info);
    } catch (err) {
      console.error('Error loading fs info:', err);
      this.errorAbout.set(this.translate.instant('fileBrowser.remoteAbout.error') + ' ' + err);
    } finally {
      this.loadingAbout.set(false);
      this.fetchDiskUsage();
    }

    // 2. Load Size/Count (Object count)
    this.loadingSize.set(true);
    try {
      const size = await this.remoteOps.getSize(name, undefined, 'ui');
      this.sizeInfo.set(size);
    } catch (err) {
      console.warn('Size check failed:', err);
    } finally {
      this.loadingSize.set(false);
    }
  }

  async fetchDiskUsage(forceRefresh = false): Promise<void> {
    await this.remoteFacadeService.getCachedOrFetchDiskUsage(
      this.data.remote.displayName,
      this.remoteName(),
      'ui',
      forceRefresh
    );
  }

  // --- Helpers for Template ---

  getRoot(about: FsInfo | null): string {
    return (about?.['Root'] as string) || '/';
  }

  getPrecisionFormatted(about: FsInfo | null): string {
    const ns = about?.Precision;
    if (ns === undefined || ns === null) return '-';
    return this.mapper.nanosecondsToDuration(ns);
  }

  getHashes(about: FsInfo | null): string[] {
    const h = about?.Hashes;
    return Array.isArray(h) ? h : [];
  }

  getFeatures(about: FsInfo | null): { key: string; value: boolean }[] {
    const features = about?.Features as Record<string, unknown>;
    if (!features) return [];
    return Object.entries(features)
      .filter(([key]) => key !== 'IsLocal') // Filter out our internal flag
      .map(([key, value]) => ({ key, value: !!value }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  getMetadataGroups(about: FsInfo | null): {
    name: string;
    items: { key: string; data: Record<string, unknown> }[];
  }[] {
    const info = about?.MetadataInfo as Record<string, unknown>;
    if (!info) return [];

    const groups = [];

    // 1. System Metadata
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

    // 2. User/Other Metadata
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
  }

  @HostListener('window:escape')
  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }
}

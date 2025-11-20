import {
  Component,
  Input,
  inject,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatExpansionModule } from '@angular/material/expansion';
import { FormsModule } from '@angular/forms';
import { MatListModule } from '@angular/material/list';
import { MatBadgeModule } from '@angular/material/badge';
import { MatSelectModule } from '@angular/material/select';
import {
  VfsList,
  VfsQueueItem,
  VfsService,
  VfsStats,
} from 'src/app/services/file-operations/vfs.service';
import { NotificationService } from '../../services/notification.service';
import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';
import { MatSliderModule } from '@angular/material/slider';

interface VfsInstance {
  name: string;
  stats: VfsStats | null;
  queue: VfsQueueItem[];
  pollInterval: string;
}

@Component({
  selector: 'app-vfs-control-panel',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatTooltipModule,
    MatProgressBarModule,
    MatExpansionModule,
    MatListModule,
    MatBadgeModule,
    MatSelectModule,
    FormsModule,
    FormatFileSizePipe,
    MatSliderModule,
  ],
  templateUrl: './vfs-control-panel.component.html',
  styleUrl: './vfs-control-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VfsControlPanelComponent implements OnInit, OnDestroy {
  @Input({ required: true }) remoteName!: string;

  private vfsService = inject(VfsService);
  private notification = inject(NotificationService);
  private cdr = inject(ChangeDetectorRef);

  vfsInstances: VfsInstance[] = [];
  selectedVfs: VfsInstance | null = null;
  loading = false;
  vfsNotFound = false;
  pollIntervalInput = '';

  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private isDestroyed = false;

  ngOnInit() {
    this.loadAll();
    this.startAutoRefresh();
  }

  ngOnDestroy() {
    this.isDestroyed = true;
    this.stopAutoRefresh();
  }

  private startAutoRefresh() {
    // 5-second interval to keep stats and queue fresh
    this.refreshInterval = setInterval(() => {
      if (!this.isDestroyed && !this.vfsNotFound) {
        this.loadStatsAndQueue();
      }
    }, 5000);
  }

  delaySliderValue = 60; // Default 60 seconds
  showDelaySlider: VfsQueueItem | null = null;

  // Add these methods
  toggleDelaySlider(item: VfsQueueItem): void {
    this.showDelaySlider = this.showDelaySlider?.id === item.id ? null : item;
    this.delaySliderValue = 60; // Reset to default
  }

  async setCustomDelay(item: VfsQueueItem): Promise<void> {
    if (!this.selectedVfs) return;

    try {
      await this.vfsService.setQueueExpiry(
        this.selectedVfs.name,
        item.id,
        this.delaySliderValue,
        false
      );
      this.notification.openSnackBar(
        `Upload delayed by ${this.delaySliderValue}s for '${item.name}'`,
        'Close',
        3000
      );
      this.showDelaySlider = null;
      await this.loadStatsAndQueue();
    } catch (error: any) {
      this.notification.showError('Failed to set custom delay: ' + String(error), 'Close');
      console.error('Error setting custom delay:', error);
    }
  }

  formatSliderLabel(value: number): string {
    if (value < 60) return `${value}s`;
    if (value < 3600) return `${Math.floor(value / 60)}m`;
    return `${Math.floor(value / 3600)}h`;
  }

  async openCacheFolder(path: string): Promise<void> {
    try {
      // TODO: Implement folder opening logic
      console.log('Opening folder:', path);
      this.notification.openSnackBar(`Opening: ${path}`, 'Close', 2000);
    } catch (error: any) {
      this.notification.showError('Failed to open folder: ' + String(error), 'Close');
    }
  }

  async openMetadataFolder(path: string): Promise<void> {
    try {
      // TODO: Implement folder opening logic
      console.log('Opening metadata folder:', path);
      this.notification.openSnackBar(`Opening: ${path}`, 'Close', 2000);
    } catch (error: any) {
      this.notification.showError('Failed to open folder: ' + String(error), 'Close');
    }
  }

  private stopAutoRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  async loadAll() {
    this.loading = true;
    this.cdr.markForCheck();

    try {
      // Get all VFS instances
      const vfsList = await this.getVfsList();
      if (!vfsList || vfsList.length === 0) {
        this.vfsNotFound = true;
        this.vfsInstances = [];
        this.selectedVfs = null;
        this.cdr.markForCheck();
        return;
      }

      // Initialize VFS instances
      this.vfsInstances = vfsList.map(name => ({
        name,
        stats: null,
        queue: [],
        pollInterval: '',
      }));

      // Select the first VFS by default
      this.selectedVfs = this.vfsInstances[0];

      // Load poll intervals for all instances
      await this.loadPollIntervals();

      // Load stats and queue for selected VFS
      await this.loadStatsAndQueue();

      this.vfsNotFound = false;
    } catch (error) {
      console.error('Failed to load VFS data:', error);
      this.vfsNotFound = true;
      this.vfsInstances = [];
      this.selectedVfs = null;
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  private async getVfsList(): Promise<string[]> {
    try {
      const vfsList: VfsList = await this.vfsService.listVfs();
      console.log('VFS List:', vfsList);

      if (!vfsList.vfses || vfsList.vfses.length === 0) {
        return [];
      }

      // Filter VFS instances that match this remote
      const remotePrefix = this.getRemotePrefix();
      const matchingVfs = vfsList.vfses.filter(vfs => vfs.startsWith(remotePrefix));

      return matchingVfs.length > 0 ? matchingVfs : [];
    } catch (error) {
      console.warn(
        'Could not check VFS list. Your rclone version might not support `vfs/list`.',
        error
      );
      return [];
    }
  }

  private async loadPollIntervals() {
    const promises = this.vfsInstances.map(async instance => {
      try {
        const pollData = await this.vfsService.getPollInterval(instance.name);
        // The response structure is { interval: { string: "1m0s" } }
        if (pollData?.interval?.string) {
          instance.pollInterval = pollData.interval.string;
        }
      } catch (error) {
        console.debug(`Failed to load poll interval for ${instance.name}:`, error);
      }
    });

    await Promise.allSettled(promises);

    // Update input field with selected VFS poll interval
    if (this.selectedVfs) {
      this.pollIntervalInput = this.selectedVfs.pollInterval;
    }

    this.cdr.markForCheck();
  }

  async loadStatsAndQueue() {
    if (!this.selectedVfs || this.isDestroyed) {
      return;
    }

    try {
      const [stats, queueData] = await Promise.all([
        this.vfsService.getStats(this.selectedVfs.name),
        this.vfsService.getQueue(this.selectedVfs.name),
      ]);

      this.selectedVfs.stats = stats;
      this.selectedVfs.queue = queueData.queue || [];
      this.vfsNotFound = false;

      this.cdr.markForCheck();
    } catch (error) {
      console.error('Failed to load VFS stats or queue:', error);

      // VFS might have been stopped
      this.vfsNotFound = true;
      this.stopAutoRefresh();
      this.cdr.markForCheck();
    }
  }

  onVfsSelectionChange() {
    if (this.selectedVfs) {
      this.pollIntervalInput = this.selectedVfs.pollInterval;
      this.loadStatsAndQueue();
    }
  }

  private getRemotePrefix(): string {
    // Remove trailing colon if present
    const baseName = this.remoteName.endsWith(':') ? this.remoteName.slice(0, -1) : this.remoteName;
    return `${baseName}:`;
  }

  async forgetFile(path: string): Promise<void> {
    if (!this.selectedVfs) return;

    try {
      const response = await this.vfsService.forget(this.selectedVfs.name, path);

      if (response.forgotten && response.forgotten.length > 0) {
        this.notification.openSnackBar(`Removed '${path}' from cache`, 'Close', 3000);
      } else {
        this.notification.openSnackBar(
          'File cannot be removed (may be uploading or already uploaded)',
          'Close',
          4000
        );
      }

      await this.loadStatsAndQueue();
    } catch (error: any) {
      this.notification.showError('Failed to forget item' + String(error), 'Close');
      console.error('Error forgetting item:', error);
    }
  }

  async clearCache(): Promise<void> {
    if (!this.selectedVfs) return;

    try {
      const response = await this.vfsService.forget(this.selectedVfs.name);
      const count = response.forgotten ? response.forgotten.length : 0;
      this.notification.openSnackBar(`Cache cleared: ${count} items removed`, 'Close', 3000);
      await this.loadStatsAndQueue();
    } catch (error: any) {
      this.notification.showError('Failed to clear cache' + String(error), 'Close');
      console.error('Error clearing cache:', error);
    }
  }

  async refreshDirectory(): Promise<void> {
    if (!this.selectedVfs) return;

    try {
      this.loading = true;
      this.cdr.markForCheck();

      await this.vfsService.refresh(this.selectedVfs.name, '', true);
      this.notification.openSnackBar('Directory cache refreshed', 'Close', 3000);
      await this.loadStatsAndQueue();
    } catch (error: any) {
      this.notification.showError('Failed to refresh directory' + String(error), 'Close');
      console.error('Error refreshing directory:', error);
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  async updatePollInterval(): Promise<void> {
    if (!this.selectedVfs || !this.pollIntervalInput.trim()) {
      return;
    }

    try {
      const response = await this.vfsService.setPollInterval(
        this.selectedVfs.name,
        this.pollIntervalInput
      );

      // Update from the response
      if (response?.interval?.string) {
        this.selectedVfs.pollInterval = response.interval.string;
        this.pollIntervalInput = response.interval.string;
      }

      this.notification.openSnackBar(
        `Poll interval updated to ${this.pollIntervalInput}`,
        'Close',
        3000
      );
      this.cdr.markForCheck();
    } catch (error: any) {
      this.notification.showError('Failed to update poll interval:' + error, 'Close');
      console.error('Error updating poll interval:', error);
    }
  }

  async delayUpload(item: VfsQueueItem): Promise<void> {
    if (!this.selectedVfs) return;

    try {
      // Set expiry to a large positive number to delay indefinitely
      await this.vfsService.setQueueExpiry(this.selectedVfs.name, item.id, 999999999, false);
      this.notification.openSnackBar(`Upload delayed for '${item.name}'`, 'Close', 3000);
      await this.loadStatsAndQueue();
    } catch (error: any) {
      this.notification.showError('Failed to delay upload: ' + String(error), 'Close');
      console.error('Error delaying upload:', error);
    }
  }

  async prioritizeUpload(item: VfsQueueItem): Promise<void> {
    if (!this.selectedVfs) return;

    try {
      // Set expiry to a large negative number to upload ASAP
      await this.vfsService.setQueueExpiry(this.selectedVfs.name, item.id, -999999999, false);
      this.notification.openSnackBar(`'${item.name}' prioritized for upload`, 'Close', 3000);
      await this.loadStatsAndQueue();
    } catch (error: any) {
      this.notification.showError('Failed to prioritize upload: ' + String(error), 'Close');
      console.error('Error prioritizing upload:', error);
    }
  }

  async clearMetadataCache(): Promise<void> {
    if (!this.selectedVfs) return;

    try {
      const response = await this.vfsService.forget(this.selectedVfs.name);
      const count = response.forgotten ? response.forgotten.length : 0;
      this.notification.openSnackBar(
        `Metadata cache cleared: ${count} items forgotten`,
        'Close',
        3000
      );
      await this.loadStatsAndQueue();
    } catch (error: any) {
      this.notification.showError('Failed to clear metadata cache: ' + String(error), 'Close');
      console.error('Error clearing metadata cache:', error);
    }
  }

  canDelayUpload(item: VfsQueueItem): boolean {
    // Can only delay if not currently uploading
    return !item.uploading;
  }

  getQueueItemStatus(item: VfsQueueItem): string {
    if (item.uploading) {
      return 'Uploading now';
    }
    if (item.expiry < 0) {
      return `Ready (${Math.abs(item.expiry).toFixed(1)}s overdue)`;
    }
    return `Waiting (${item.expiry.toFixed(1)}s)`;
  }

  getTotalQueueSize(): number {
    if (!this.selectedVfs) return 0;
    return this.selectedVfs.queue.reduce((sum, item) => sum + item.size, 0);
  }

  getUploadingCount(): number {
    if (!this.selectedVfs) return 0;
    return this.selectedVfs.queue.filter(item => item.uploading).length;
  }

  canForgetFile(item: VfsQueueItem): boolean {
    // Can only forget if not uploading and no tries yet
    return !item.uploading && item.tries === 0;
  }

  trackByFn(index: number, item: VfsQueueItem): number | string {
    return item.id ?? index;
  }

  trackByVfsName(index: number, vfs: VfsInstance): string {
    return vfs.name;
  }
}

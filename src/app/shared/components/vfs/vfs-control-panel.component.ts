import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  input,
  signal,
  computed,
  WritableSignal,
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
  remoteName = input.required<string>();

  private readonly vfsService = inject(VfsService);
  private readonly notification = inject(NotificationService);

  vfsInstances = signal<VfsInstance[]>([]);
  selectedVfs: WritableSignal<VfsInstance | null> = signal(null);
  loading = signal(false);
  vfsNotFound = signal(false);
  pollIntervalInput = signal('');

  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private isDestroyed = false;

  delaySliderValue = signal(60); // Default 60 seconds
  showDelaySlider = signal<VfsQueueItem | null>(null);

  totalQueueSize = computed(() => {
    const selected = this.selectedVfs();
    if (!selected) return 0;
    return selected.queue.reduce((sum, item) => sum + item.size, 0);
  });

  uploadingCount = computed(() => {
    const selected = this.selectedVfs();
    if (!selected) return 0;
    return selected.queue.filter(item => item.uploading).length;
  });

  ngOnInit(): void {
    this.loadAll();
    this.startAutoRefresh();
  }

  ngOnDestroy(): void {
    this.isDestroyed = true;
    this.stopAutoRefresh();
  }

  private startAutoRefresh(): void {
    // 5-second interval to keep stats and queue fresh
    this.refreshInterval = setInterval(() => {
      if (!this.isDestroyed && !this.vfsNotFound()) {
        this.loadStatsAndQueue();
      }
    }, 5000);
  }

  toggleDelaySlider(item: VfsQueueItem): void {
    this.showDelaySlider.update(current => (current?.id === item.id ? null : item));
    this.delaySliderValue.set(60); // Reset to default
  }

  async setCustomDelay(item: VfsQueueItem): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected) return;

    try {
      await this.vfsService.setQueueExpiry(selected.name, item.id, this.delaySliderValue(), false);
      this.notification.openSnackBar(
        `Upload delayed by ${this.delaySliderValue()}s for '${item.name}'`,
        'Close',
        3000
      );
      this.showDelaySlider.set(null);
      await this.loadStatsAndQueue();
    } catch (error: unknown) {
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
    } catch (error: unknown) {
      this.notification.showError('Failed to open folder: ' + String(error), 'Close');
    }
  }

  async openMetadataFolder(path: string): Promise<void> {
    try {
      // TODO: Implement folder opening logic
      console.log('Opening metadata folder:', path);
      this.notification.openSnackBar(`Opening: ${path}`, 'Close', 2000);
    } catch (error: unknown) {
      this.notification.showError('Failed to open folder: ' + String(error), 'Close');
    }
  }

  private stopAutoRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  async loadAll(): Promise<void> {
    this.loading.set(true);

    try {
      const vfsList = await this.getVfsList();
      if (!vfsList || vfsList.length === 0) {
        this.vfsNotFound.set(true);
        this.vfsInstances.set([]);
        this.selectedVfs.set(null);
        return;
      }

      const instances = vfsList.map(name => ({
        name,
        stats: null,
        queue: [],
        pollInterval: '',
      }));
      this.vfsInstances.set(instances);
      this.selectedVfs.set(instances[0]);

      await this.loadPollIntervals();
      await this.loadStatsAndQueue();

      this.vfsNotFound.set(false);
    } catch (error: unknown) {
      console.error('Failed to load VFS data:', error);
      this.vfsNotFound.set(true);
      this.vfsInstances.set([]);
      this.selectedVfs.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  private async getVfsList(): Promise<string[]> {
    try {
      const vfsList: VfsList = await this.vfsService.listVfs();
      if (!vfsList.vfses || vfsList.vfses.length === 0) {
        return [];
      }
      const remotePrefix = this.getRemotePrefix();
      return vfsList.vfses.filter(vfs => vfs.startsWith(remotePrefix));
    } catch (error: unknown) {
      console.warn(
        'Could not check VFS list. Your rclone version might not support `vfs/list`.',
        error
      );
      return [];
    }
  }

  private async loadPollIntervals(): Promise<void> {
    const instances = this.vfsInstances();
    const promises = instances.map(async instance => {
      try {
        const pollData = await this.vfsService.getPollInterval(instance.name);
        if (pollData?.interval?.string) {
          instance.pollInterval = pollData.interval.string;
        }
      } catch (error) {
        console.debug(`Failed to load poll interval for ${instance.name}:`, error);
      }
    });

    await Promise.allSettled(promises);
    this.vfsInstances.set([...instances]);

    const selected = this.selectedVfs();
    if (selected) {
      this.pollIntervalInput.set(selected.pollInterval);
    }
  }

  async loadStatsAndQueue(): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected || this.isDestroyed) {
      return;
    }

    try {
      const [stats, queueData] = await Promise.all([
        this.vfsService.getStats(selected.name),
        this.vfsService.getQueue(selected.name),
      ]);

      selected.stats = stats;
      selected.queue = queueData.queue || [];
      this.selectedVfs.set({ ...selected });
      this.vfsNotFound.set(false);
    } catch (error: unknown) {
      console.error('Failed to load VFS stats or queue:', error);
      this.vfsNotFound.set(true);
      this.stopAutoRefresh();
    }
  }

  onVfsSelectionChange(vfs: VfsInstance | null): void {
    this.selectedVfs.set(vfs);
    if (vfs) {
      this.pollIntervalInput.set(vfs.pollInterval);
      this.loadStatsAndQueue();
    }
  }

  private getRemotePrefix(): string {
    const name = this.remoteName();
    return name.endsWith(':') ? name.slice(0, -1) : name;
  }

  async forgetFile(path: string): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected) return;

    try {
      const response = await this.vfsService.forget(selected.name, path);

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
    } catch (error: unknown) {
      this.notification.showError('Failed to forget item' + String(error), 'Close');
      console.error('Error forgetting item:', error);
    }
  }

  async clearCache(): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected) return;

    try {
      const response = await this.vfsService.forget(selected.name);
      const count = response.forgotten ? response.forgotten.length : 0;
      this.notification.openSnackBar(`Cache cleared: ${count} items removed`, 'Close', 3000);
      await this.loadStatsAndQueue();
    } catch (error: unknown) {
      this.notification.showError('Failed to clear cache' + String(error), 'Close');
      console.error('Error clearing cache:', error);
    }
  }

  async refreshDirectory(): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected) return;

    try {
      this.loading.set(true);
      await this.vfsService.refresh(selected.name, '', true);
      this.notification.openSnackBar('Directory cache refreshed', 'Close', 3000);
      await this.loadStatsAndQueue();
    } catch (error: unknown) {
      this.notification.showError('Failed to refresh directory' + String(error), 'Close');
      console.error('Error refreshing directory:', error);
    } finally {
      this.loading.set(false);
    }
  }

  async updatePollInterval(): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected || !this.pollIntervalInput().trim()) {
      return;
    }

    try {
      const response = await this.vfsService.setPollInterval(
        selected.name,
        this.pollIntervalInput()
      );
      if (response?.interval?.string) {
        selected.pollInterval = response.interval.string;
        this.pollIntervalInput.set(response.interval.string);
        this.selectedVfs.set({ ...selected });
      }
      this.notification.openSnackBar(
        `Poll interval updated to ${this.pollIntervalInput()}`,
        'Close',
        3000
      );
    } catch (error: unknown) {
      this.notification.showError('Failed to update poll interval:' + error, 'Close');
      console.error('Error updating poll interval:', error);
    }
  }

  async delayUpload(item: VfsQueueItem): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected) return;

    try {
      // Set expiry to a large positive number to delay indefinitely
      await this.vfsService.setQueueExpiry(selected.name, item.id, 999999999, false);
      this.notification.openSnackBar(`Upload delayed for '${item.name}'`, 'Close', 3000);
      await this.loadStatsAndQueue();
    } catch (error: unknown) {
      this.notification.showError('Failed to delay upload: ' + String(error), 'Close');
      console.error('Error delaying upload:', error);
    }
  }

  async prioritizeUpload(item: VfsQueueItem): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected) return;

    try {
      // Set expiry to a large negative number to upload ASAP
      await this.vfsService.setQueueExpiry(selected.name, item.id, -999999999, false);
      this.notification.openSnackBar(`'${item.name}' prioritized for upload`, 'Close', 3000);
      await this.loadStatsAndQueue();
    } catch (error: unknown) {
      this.notification.showError('Failed to prioritize upload: ' + String(error), 'Close');
      console.error('Error prioritizing upload:', error);
    }
  }

  async clearMetadataCache(): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected) return;

    try {
      const response = await this.vfsService.forget(selected.name);
      const count = response.forgotten ? response.forgotten.length : 0;
      this.notification.openSnackBar(
        `Metadata cache cleared: ${count} items forgotten`,
        'Close',
        3000
      );
      await this.loadStatsAndQueue();
    } catch (error: unknown) {
      this.notification.showError('Failed to clear metadata cache: ' + String(error), 'Close');
      console.error('Error clearing metadata cache:', error);
    }
  }

  canDelayUpload(item: VfsQueueItem): boolean {
    return !item.uploading;
  }

  getQueueItemStatus(item: VfsQueueItem): string {
    if (item.uploading) return 'Uploading now';
    if (item.expiry < 0) return `Ready (${Math.abs(item.expiry).toFixed(1)}s overdue)`;
    return `Waiting (${item.expiry.toFixed(1)}s)`;
  }

  canForgetFile(item: VfsQueueItem): boolean {
    return !item.uploading && item.tries === 0;
  }

  trackByFn(index: number, item: VfsQueueItem): number | string {
    return item.id ?? index;
  }

  trackByVfsName(index: number, vfs: VfsInstance): string {
    return vfs.name;
  }
}

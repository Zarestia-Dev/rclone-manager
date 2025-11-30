import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  input,
  signal,
  computed,
  effect,
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
import { MatSliderModule } from '@angular/material/slider';
import {
  VfsList,
  VfsQueueItem,
  VfsService,
  VfsStats,
} from 'src/app/services/file-operations/vfs.service';
import { PathSelectionService } from 'src/app/services/remote/path-selection.service';
import { NotificationService } from '../../services/notification.service';
import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';
import { FileSystemService } from '@app/services';

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
})
export class VfsControlPanelComponent implements OnInit, OnDestroy {
  // Inputs
  remoteName = input.required<string>();

  // Services
  private readonly vfsService = inject(VfsService);
  private readonly notification = inject(NotificationService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly pathSelectionService = inject(PathSelectionService);

  // State
  vfsInstances = signal<VfsInstance[]>([]);
  selectedVfs = signal<VfsInstance | null>(null);
  loading = signal(false);
  vfsNotFound = signal(false);
  pollIntervalInput = signal('');

  // Delay slider state
  delaySliderValue = signal(60);
  showDelaySlider = signal<VfsQueueItem | null>(null);

  // Computed values
  totalQueueSize = computed(() => {
    const selected = this.selectedVfs();
    return selected?.queue.reduce((sum, item) => sum + item.size, 0) ?? 0;
  });

  uploadingCount = computed(() => {
    const selected = this.selectedVfs();
    return selected?.queue.filter(item => item.uploading).length ?? 0;
  });

  // Private
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private isDestroyed = false;
  private readonly AUTO_REFRESH_INTERVAL = 5000;
  private readonly DEFAULT_DELAY_SECONDS = 60;
  private readonly MAX_DELAY_SECONDS = 999999999;

  constructor() {
    // Sync poll interval input when selected VFS changes
    effect(() => {
      const selected = this.selectedVfs();
      if (selected) {
        this.pollIntervalInput.set(selected.pollInterval);
      }
    });
  }

  ngOnInit(): void {
    this.initialize();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // ============ Initialization & Cleanup ============

  private async initialize(): Promise<void> {
    await this.loadAll();
    this.startAutoRefresh();
  }

  private cleanup(): void {
    this.isDestroyed = true;
    this.stopAutoRefresh();
  }

  private startAutoRefresh(): void {
    this.refreshInterval = setInterval(() => {
      if (!this.isDestroyed && !this.vfsNotFound()) {
        this.loadStatsAndQueue();
      }
    }, this.AUTO_REFRESH_INTERVAL);
  }

  private stopAutoRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  // ============ Data Loading ============

  async loadAll(): Promise<void> {
    this.loading.set(true);

    try {
      const vfsList = await this.fetchVfsList();

      if (vfsList.length === 0) {
        this.handleNoVfsFound();
        return;
      }

      await this.initializeVfsInstances(vfsList);
      this.vfsNotFound.set(false);
    } catch (error) {
      this.handleLoadError(error);
    } finally {
      this.loading.set(false);
    }
  }

  private async fetchVfsList(): Promise<string[]> {
    try {
      const vfsList: VfsList = await this.vfsService.listVfs();
      if (!vfsList.vfses || vfsList.vfses.length === 0) {
        return [];
      }
      const remotePrefix = this.getRemotePrefix();
      return vfsList.vfses.filter(vfs => vfs.startsWith(remotePrefix));
    } catch (error) {
      console.warn(
        'Could not check VFS list. Your rclone version might not support `vfs/list`.',
        error
      );
      return [];
    }
  }

  private async initializeVfsInstances(vfsList: string[]): Promise<void> {
    const instances: VfsInstance[] = vfsList.map(name => ({
      name,
      stats: null,
      queue: [],
      pollInterval: '',
    }));

    this.vfsInstances.set(instances);
    this.selectedVfs.set(instances[0]);

    await Promise.all([this.loadPollIntervals(), this.loadStatsAndQueue()]);
  }

  private async loadPollIntervals(): Promise<void> {
    const instances = this.vfsInstances();

    await Promise.allSettled(
      instances.map(async instance => {
        try {
          const pollData = await this.vfsService.getPollInterval(instance.name);
          if (pollData?.interval?.string) {
            instance.pollInterval = pollData.interval.string;
          }
        } catch (error) {
          console.debug(`Failed to load poll interval for ${instance.name}:`, error);
        }
      })
    );

    this.vfsInstances.set([...instances]);
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
    } catch (error) {
      console.error('Failed to load VFS stats or queue:', error);
      this.vfsNotFound.set(true);
      this.stopAutoRefresh();
    }
  }

  // ============ Queue Management ============

  async prioritizeUpload(item: VfsQueueItem): Promise<void> {
    await this.setQueueItemExpiry(
      item,
      -this.MAX_DELAY_SECONDS,
      `'${item.name}' prioritized for upload`
    );
  }

  async delayUpload(item: VfsQueueItem): Promise<void> {
    await this.setQueueItemExpiry(
      item,
      this.MAX_DELAY_SECONDS,
      `Upload delayed for '${item.name}'`
    );
  }

  async setCustomDelay(item: VfsQueueItem): Promise<void> {
    await this.setQueueItemExpiry(
      item,
      this.delaySliderValue(),
      `Upload delayed by ${this.delaySliderValue()}s for '${item.name}'`
    );
    this.showDelaySlider.set(null);
  }

  private async setQueueItemExpiry(
    item: VfsQueueItem,
    expiry: number,
    successMessage: string
  ): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected) return;

    try {
      await this.vfsService.setQueueExpiry(selected.name, item.id, expiry, false);
      this.notification.openSnackBar(successMessage, 'Close', 3000);
      await this.loadStatsAndQueue();
    } catch (error) {
      this.notification.showError(`Failed to update queue item: ${String(error)}`, 'Close');
      console.error('Error updating queue item:', error);
    }
  }

  toggleDelaySlider(item: VfsQueueItem): void {
    const current = this.showDelaySlider();
    this.showDelaySlider.set(current?.id === item.id ? null : item);
    this.delaySliderValue.set(this.DEFAULT_DELAY_SECONDS);
  }

  // ============ Cache Management ============

  async forgetFile(path: string): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected) return;

    try {
      const response = await this.vfsService.forget(selected.name, path);

      if (response.forgotten?.length > 0) {
        this.notification.openSnackBar(`Removed '${path}' from cache`, 'Close', 3000);
      } else {
        this.notification.openSnackBar(
          'File cannot be removed (may be uploading or already uploaded)',
          'Close',
          4000
        );
      }

      await this.loadStatsAndQueue();
    } catch (error) {
      this.notification.showError(`Failed to forget item: ${String(error)}`, 'Close');
      console.error('Error forgetting item:', error);
    }
  }

  async clearMetadataCache(): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected) return;

    try {
      const response = await this.vfsService.forget(selected.name);
      const count = response.forgotten?.length ?? 0;
      this.notification.openSnackBar(
        `Metadata cache cleared: ${count} items forgotten`,
        'Close',
        3000
      );
      await this.loadStatsAndQueue();
    } catch (error) {
      this.notification.showError(`Failed to clear metadata cache: ${String(error)}`, 'Close');
      console.error('Error clearing metadata cache:', error);
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
    } catch (error) {
      this.notification.showError(`Failed to refresh directory: ${String(error)}`, 'Close');
      console.error('Error refreshing directory:', error);
    } finally {
      this.loading.set(false);
    }
  }

  // ============ Settings ============

  async updatePollInterval(): Promise<void> {
    const selected = this.selectedVfs();
    const interval = this.pollIntervalInput().trim();

    if (!selected || !interval) {
      return;
    }

    try {
      const response = await this.vfsService.setPollInterval(selected.name, interval);

      if (response?.interval?.string) {
        selected.pollInterval = response.interval.string;
        this.pollIntervalInput.set(response.interval.string);
        this.selectedVfs.set({ ...selected });
      }

      this.notification.openSnackBar(`Poll interval updated to ${interval}`, 'Close', 3000);
    } catch (error) {
      this.notification.showError(`Failed to update poll interval: ${error}`, 'Close');
      console.error('Error updating poll interval:', error);
    }
  }

  onVfsSelectionChange(vfs: VfsInstance | null): void {
    this.selectedVfs.set(vfs);
    if (vfs) {
      this.loadStatsAndQueue();
    }
  }

  // ============ UI Helpers ============

  async openFolder(path: string): Promise<void> {
    try {
      this.fileSystemService.openInFiles(path);
    } catch (error) {
      this.notification.showError(`Failed to open folder: ${String(error)}`, 'Close');
    }
  }

  formatSliderLabel(value: number): string {
    if (value < 60) return `${value}s`;
    if (value < 3600) return `${Math.floor(value / 60)}m`;
    return `${Math.floor(value / 3600)}h`;
  }

  getQueueItemStatus(item: VfsQueueItem): string {
    if (item.uploading) return 'Uploading now';
    if (item.expiry < 0) return `Ready (${Math.abs(item.expiry).toFixed(1)}s overdue)`;
    return `Waiting (${item.expiry.toFixed(1)}s)`;
  }

  canDelayUpload(item: VfsQueueItem): boolean {
    return !item.uploading;
  }

  canForgetFile(item: VfsQueueItem): boolean {
    return !item.uploading && item.tries === 0;
  }

  trackByFn(_index: number, item: VfsQueueItem): number | string {
    return item.id ?? _index;
  }

  trackByVfsName(_index: number, vfs: VfsInstance): string {
    return vfs.name;
  }

  // ============ Error Handling ============

  private handleNoVfsFound(): void {
    this.vfsNotFound.set(true);
    this.vfsInstances.set([]);
    this.selectedVfs.set(null);
  }

  private handleLoadError(error: unknown): void {
    console.error('Failed to load VFS data:', error);
    this.vfsNotFound.set(true);
    this.vfsInstances.set([]);
    this.selectedVfs.set(null);
  }

  private getRemotePrefix(): string {
    const name = this.remoteName();
    return this.pathSelectionService.normalizeRemoteName(name);
  }
}

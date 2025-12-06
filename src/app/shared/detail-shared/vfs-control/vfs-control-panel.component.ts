import {
  Component,
  inject,
  OnInit,
  input,
  signal,
  computed,
  effect,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatExpansionModule } from '@angular/material/expansion';
import { FormsModule } from '@angular/forms';
import { MatTableModule, MatTable } from '@angular/material/table';
import { MatBadgeModule } from '@angular/material/badge';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSliderModule } from '@angular/material/slider';
import { switchMap, filter, retry } from 'rxjs/operators';
import { timer, from } from 'rxjs';

// Services
import {
  VfsList,
  VfsQueueItem,
  VfsService,
  VfsStats,
} from 'src/app/services/file-operations/vfs.service';
import { PathSelectionService } from 'src/app/services/remote/path-selection.service';
import { NotificationService } from '../../services/notification.service';
import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';
import { FileSystemService, MountManagementService } from '@app/services';

interface VfsInstance {
  name: string;
  stats: VfsStats | null;
  queue: VfsQueueItem[];
  pollInterval: string;
}

// Constants
const POLL_INTERVAL_MS = 5000;
const PRIORITY_EXPIRY = -999_999_999;
const DELAY_EXPIRY = 999_999_999;
const DELAY_SLIDER_DEFAULT = 60;

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
    MatTableModule,
    MatBadgeModule,
    MatSelectModule,
    FormsModule,
    FormatFileSizePipe,
    MatSliderModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './vfs-control-panel.component.html',
  styleUrl: './vfs-control-panel.component.scss',
})
export class VfsControlPanelComponent implements OnInit {
  // Inputs & Services
  remoteName = input.required<string>();
  private readonly vfsService = inject(VfsService);
  private readonly notification = inject(NotificationService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly mountService = inject(MountManagementService);

  // ViewChild for table rendering
  @ViewChild(MatTable) table?: MatTable<VfsQueueItem>;

  // State
  vfsInstances = signal<VfsInstance[]>([]);
  selectedVfs = signal<VfsInstance | null>(null);
  loading = signal(false);
  vfsNotFound = signal(false);
  pollIntervalInput = signal('');

  // Delay slider state
  delaySliderValue = signal(DELAY_SLIDER_DEFAULT);
  showDelaySlider = signal<number | null>(null);

  // Computed
  totalQueueSize = computed(
    () => this.selectedVfs()?.queue.reduce((sum, i) => sum + i.size, 0) ?? 0
  );
  uploadingCount = computed(() => this.selectedVfs()?.queue.filter(i => i.uploading).length ?? 0);

  displayedColumns: string[] = ['name', 'size', 'status'];
  isDetailRow = (_: number, row: VfsQueueItem): boolean => this.showDelaySlider() === row.id;

  constructor() {
    // Sync poll interval input when selected VFS changes
    effect(() => {
      const vfs = this.selectedVfs();
      if (vfs) this.pollIntervalInput.set(vfs.pollInterval);
    });

    // Force table re-render when showDelaySlider changes
    effect(() => {
      this.showDelaySlider(); // Register dependency
      this.table?.renderRows(); // Force update
    });

    // Auto-refresh logic using RxJS timer
    timer(0, POLL_INTERVAL_MS)
      .pipe(
        filter(() => !this.vfsNotFound() && !!this.selectedVfs()),
        switchMap(() => from(this.refreshStatsAndQueue())),
        retry({ delay: POLL_INTERVAL_MS }), // Keep polling even if one request fails
        takeUntilDestroyed()
      )
      .subscribe();

    // Listen for mount changes
    this.mountService.mountedRemotes$.pipe(takeUntilDestroyed()).subscribe(() => this.loadAll());
  }

  ngOnInit(): void {
    this.loadAll();
  }

  // ============ Data Loading ============

  async loadAll(): Promise<void> {
    this.loading.set(true);
    try {
      const vfsList: VfsList = await this.vfsService.listVfs();
      const filteredNames = this.filterVfsNames(vfsList?.vfses || []);

      if (filteredNames.length === 0) {
        this.vfsNotFound.set(true);
        this.vfsInstances.set([]);
        this.selectedVfs.set(null);
        return;
      }

      // Merge new names with existing instances to prevent UI flicker
      const currentMap = new Map(this.vfsInstances().map(i => [i.name, i]));
      const newInstances: VfsInstance[] = filteredNames.map(
        name => currentMap.get(name) || { name, stats: null, queue: [], pollInterval: '' }
      );

      this.vfsInstances.set(newInstances);
      this.vfsNotFound.set(false);

      // Ensure selection
      const selected = this.selectedVfs();
      if (!selected || !filteredNames.includes(selected.name)) {
        this.selectedVfs.set(newInstances[0] || null);
      }

      if (this.selectedVfs()) {
        await Promise.all([this.loadPollIntervals(), this.refreshStatsAndQueue()]);
      }
    } catch (error) {
      console.error('Error loading VFS:', error);
      this.vfsNotFound.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private filterVfsNames(allVfs: string[]): string[] {
    const prefix = this.pathSelectionService.normalizeRemoteName(this.remoteName());
    return allVfs.filter(name => {
      if (name === prefix) return true;
      // Check if name starts with prefix + separator
      return name.startsWith(prefix) && [':', '/', '\\'].includes(name[prefix.length]);
    });
  }

  // Separate function for the frequent polling operation
  private async refreshStatsAndQueue(): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected) return;

    try {
      const [stats, queueData] = await Promise.all([
        this.vfsService.getStats(selected.name),
        this.vfsService.getQueue(selected.name),
      ]);

      const updated = { ...selected, stats, queue: queueData.queue || [] };

      this.selectedVfs.set(updated);
      this.vfsInstances.update(list => list.map(i => (i.name === selected.name ? updated : i)));
    } catch (err) {
      console.error('Poll failed', err);
    }
  }

  private async loadPollIntervals(): Promise<void> {
    const instances = this.vfsInstances();
    // Run side-effect to fetch intervals, then update signal once
    await Promise.all(
      instances.map(async inst => {
        try {
          const res = await this.vfsService.getPollInterval(inst.name);
          if (res?.interval?.string) inst.pollInterval = res.interval.string;
        } catch {
          console.warn(`Failed to load poll interval for ${inst.name}`);
        }
      })
    );
    this.vfsInstances.set([...instances]);
  }

  compareVfs(o1: VfsInstance, o2: VfsInstance): boolean {
    return o1?.name === o2?.name;
  }

  async prioritizeUpload(item: VfsQueueItem): Promise<void> {
    await this.updateExpiry(item, PRIORITY_EXPIRY, `'${item.name}' prioritized`);
  }

  async delayUpload(item: VfsQueueItem): Promise<void> {
    await this.updateExpiry(item, DELAY_EXPIRY, `Delayed '${item.name}'`);
  }

  async setCustomDelay(item: VfsQueueItem): Promise<void> {
    await this.updateExpiry(item, this.delaySliderValue(), `Delayed ${this.delaySliderValue()}s`);
    this.showDelaySlider.set(null);
  }

  private async updateExpiry(item: VfsQueueItem, expiry: number, msg: string): Promise<void> {
    const fs = this.selectedVfs()?.name;
    if (!fs) return;
    try {
      await this.vfsService.setQueueExpiry(fs, item.id, expiry, false);
      this.notification.openSnackBar(msg, 'Close', 3000);
      this.refreshStatsAndQueue();
    } catch (e) {
      this.notification.showError(`Action failed: ${e}`, 'Close');
    }
  }

  async forgetFile(path: string): Promise<void> {
    this.performAction(async fs => {
      const res = await this.vfsService.forget(fs, path);
      return res.forgotten?.length ? `Removed '${path}'` : 'File cannot be removed';
    });
  }

  async clearMetadataCache(): Promise<void> {
    this.performAction(async fs => {
      const res = await this.vfsService.forget(fs);
      return `Cleared ${res.forgotten?.length ?? 0} items`;
    });
  }

  async refreshDirectory(): Promise<void> {
    this.loading.set(true);
    await this.performAction(async fs => {
      await this.vfsService.refresh(fs, '', true);
      return 'Directory refreshed';
    });
    this.loading.set(false);
  }

  async updatePollInterval(): Promise<void> {
    const val = this.pollIntervalInput().trim();
    if (!val) return;

    await this.performAction(async fs => {
      const res = await this.vfsService.setPollInterval(fs, val);
      if (res?.interval?.string) {
        this.selectedVfs.update(v => (v ? { ...v, pollInterval: res.interval.string } : null));
      }
      return `Interval set to ${val}`;
    });
  }

  // Helper to wrap generic actions that need a VFS name and refresh afterwards
  private async performAction(action: (fsName: string) => Promise<string>): Promise<void> {
    const fs = this.selectedVfs()?.name;
    if (!fs) return;
    try {
      const msg = await action(fs);
      this.notification.openSnackBar(msg, 'Close', 3000);
      await this.refreshStatsAndQueue();
    } catch (e) {
      this.notification.showError(`Error: ${e}`, 'Close');
    }
  }

  // ============ UI Helpers ============

  openFolder(path: string): void {
    this.fileSystemService.openInFiles(path);
  }

  formatSliderLabel(val: number): string {
    return val < 60
      ? `${val}s`
      : val < 3600
        ? `${Math.floor(val / 60)}m`
        : `${Math.floor(val / 3600)}h`;
  }

  getQueueItemStatus(item: VfsQueueItem): string {
    if (item.uploading) return 'Uploading now';
    return item.expiry < 0
      ? `Ready (${Math.abs(item.expiry).toFixed(1)}s overdue)`
      : `Waiting (${item.expiry.toFixed(1)}s)`;
  }

  toggleDelaySlider(item: VfsQueueItem): void {
    this.showDelaySlider.update(curr => (curr === item.id ? null : item.id));
    this.delaySliderValue.set(DELAY_SLIDER_DEFAULT);
  }

  canDelayUpload(item: VfsQueueItem): boolean {
    return !item.uploading;
  }
  trackByFn(_: number, item: VfsQueueItem): number {
    return item.id;
  }
  trackByVfsName(_: number, vfs: VfsInstance): string {
    return vfs.name;
  }
  onVfsSelectionChange(vfs: VfsInstance | null): void {
    this.selectedVfs.set(vfs);
    this.refreshStatsAndQueue();
  }
}

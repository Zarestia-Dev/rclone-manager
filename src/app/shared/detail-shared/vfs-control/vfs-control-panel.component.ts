import { Component, inject, input, signal, computed, effect, ViewChild } from '@angular/core';

import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
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
import { NotificationService } from '@app/services';
import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';
import {
  FileSystemService,
  MountManagementService,
  ServeManagementService,
  RemoteManagementService,
} from '@app/services';

interface VfsInstance {
  name: string;
  stats: VfsStats | null;
  queue: VfsQueueItem[];
  pollInterval: string;
  pollIntervalSupported?: boolean;
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
    TranslateModule,
  ],
  templateUrl: './vfs-control-panel.component.html',
  styleUrl: './vfs-control-panel.component.scss',
})
export class VfsControlPanelComponent {
  // Inputs & Services
  remoteName = input.required<string>();
  private readonly vfsService = inject(VfsService);
  private readonly notification = inject(NotificationService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly mountService = inject(MountManagementService);
  private readonly serveService = inject(ServeManagementService);
  private readonly translate = inject(TranslateService);
  private readonly remoteService = inject(RemoteManagementService);

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
  showAdvancedConfig = signal(false);
  configSearchTerm = signal('');

  // Computed
  totalQueueSize = computed(
    () => this.selectedVfs()?.queue.reduce((sum, i) => sum + i.size, 0) ?? 0
  );
  uploadingCount = computed(() => this.selectedVfs()?.queue.filter(i => i.uploading).length ?? 0);

  // Check if selected VFS has an index suffix (e.g., "remoteName:[0]")
  // These indexed VFS entries are not supported by rclone's VFS RC API
  isIndexedVfs = computed(() => {
    const name = this.selectedVfs()?.name;
    if (!name) return false;
    return /:\[\d+\]$/.test(name);
  });

  // Simplified: true when we have a usable (non-indexed) VFS selected
  hasUsableVfs = computed(() => !!this.selectedVfs() && !this.isIndexedVfs());

  // Computed VFS options grouped by category (future-proof)
  vfsConfigGroups = computed(() => {
    const opts = this.selectedVfs()?.stats?.opt;
    if (!opts) return [];

    const searchTerm = this.configSearchTerm().toLowerCase();
    const filterOption = (name: string, value: unknown) => {
      if (!searchTerm) return true;
      return (
        name.toLowerCase().includes(searchTerm) || String(value).toLowerCase().includes(searchTerm)
      );
    };

    const grouped = new Map<string, { key: string; value: string; rawValue: unknown }[]>();
    const groupOrder = ['Booleans', 'Durations', 'Sizes', 'Permissions', 'Numbers', 'Strings'];

    for (const [key, rawValue] of Object.entries(opts)) {
      if (!filterOption(key, rawValue)) continue;

      const group = this.getOptionGroup(key, rawValue);
      const item = { key, value: this.formatOptionValue(key, rawValue), rawValue };
      const list = grouped.get(group) ?? [];
      list.push(item);
      grouped.set(group, list);
    }

    return groupOrder
      .filter(name => (grouped.get(name)?.length ?? 0) > 0)
      .map(name => ({ name, items: grouped.get(name) ?? [] }));
  });

  displayedColumns: string[] = ['name', 'size', 'status'];
  isDetailRow = (_: number, row: VfsQueueItem): boolean => this.showDelaySlider() === row.id;

  constructor() {
    // React to remote name changes
    effect(() => {
      this.remoteName();
      this.loadAll();
    });

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

    // Listen for serve changes
    this.serveService.runningServes$.pipe(takeUntilDestroyed()).subscribe(() => this.loadAll());
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
        name =>
          currentMap.get(name) || {
            name,
            stats: null,
            queue: [],
            pollInterval: '',
            pollIntervalSupported: true, // Assume supported until checked
          }
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

    // Skip if no usable VFS (includes indexed VFS entries)
    if (!this.hasUsableVfs()) {
      return;
    }

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
    // Helper to check if a VFS name is indexed
    const isIndexed = (name: string): boolean => /:\[\d+\]$/.test(name);

    // Use request info to check features
    const fsInfo = await this.remoteService.getFsInfo(this.remoteName());
    const supportsPollInterval = fsInfo.Features?.['ChangeNotify'];

    // Run side-effect to fetch intervals, then update signal once
    await Promise.all(
      instances.map(async inst => {
        // Skip indexed VFS entries - they're not supported by rclone's API
        if (isIndexed(inst.name)) return;

        // Skip if remote doesn't support ChangeNotify (which implies poll-interval support)
        if (!supportsPollInterval) {
          inst.pollIntervalSupported = false;
          return;
        }

        inst.pollIntervalSupported = true;

        try {
          const res = await this.vfsService.getPollInterval(inst.name);
          if (res?.interval?.string) inst.pollInterval = res.interval.string;
        } catch {
          console.warn(`Failed to load poll interval for ${inst.name}`);
        }
      })
    );
    this.vfsInstances.set([...instances]);

    // Force update selectedVfs to trigger UI refresh
    const selected = this.selectedVfs();
    if (selected) {
      const updated = instances.find(i => i.name === selected.name);
      if (updated) {
        this.selectedVfs.set({ ...updated });
      }
    }
  }

  compareVfs(o1: VfsInstance, o2: VfsInstance): boolean {
    return o1?.name === o2?.name;
  }

  async prioritizeUpload(item: VfsQueueItem): Promise<void> {
    await this.updateExpiry(
      item,
      PRIORITY_EXPIRY,
      this.translate.instant('shared.vfsControl.actions.messages.prioritized', {
        name: item.name,
      })
    );
  }

  async delayUpload(item: VfsQueueItem): Promise<void> {
    await this.updateExpiry(
      item,
      DELAY_EXPIRY,
      this.translate.instant('shared.vfsControl.actions.messages.delayed', { name: item.name })
    );
  }

  async setCustomDelay(item: VfsQueueItem): Promise<void> {
    await this.updateExpiry(
      item,
      this.delaySliderValue(),
      this.translate.instant('shared.vfsControl.actions.messages.delayedSeconds', {
        seconds: this.delaySliderValue(),
      })
    );
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
      this.notification.showError(
        this.translate.instant('shared.vfsControl.actions.messages.actionFailed', { error: e }),
        'Close'
      );
    }
  }

  async forgetFile(path: string): Promise<void> {
    this.performAction(async fs => {
      const res = await this.vfsService.forget(fs, path);
      return res.forgotten?.length
        ? this.translate.instant('shared.vfsControl.actions.messages.removed', { path })
        : this.translate.instant('shared.vfsControl.actions.messages.removeFailed');
    });
  }

  async clearMetadataCache(): Promise<void> {
    this.performAction(async fs => {
      const res = await this.vfsService.forget(fs);
      return this.translate.instant('shared.vfsControl.actions.messages.cleared', {
        count: res.forgotten?.length ?? 0,
      });
    });
  }

  async refreshDirectory(): Promise<void> {
    this.loading.set(true);
    await this.performAction(async fs => {
      await this.vfsService.refresh(fs, '', true);
      return this.translate.instant('shared.vfsControl.actions.messages.directoryRefreshed');
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
      return this.translate.instant('shared.vfsControl.actions.messages.intervalSet', { val });
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
      this.notification.showError(
        this.translate.instant('shared.vfsControl.actions.messages.error', { error: e }),
        'Close'
      );
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
    if (item.uploading) {
      return this.translate.instant('shared.vfsControl.queue.statusText.uploading');
    }
    return item.expiry < 0
      ? this.translate.instant('shared.vfsControl.queue.statusText.ready', {
          seconds: Math.abs(item.expiry).toFixed(1),
        })
      : this.translate.instant('shared.vfsControl.queue.statusText.waiting', {
          seconds: item.expiry.toFixed(1),
        });
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

  // ============ Config Formatting ============

  formatOptionValue(key: string, value: unknown): string {
    if (value === null || value === undefined) return 'N/A';

    if (typeof value === 'boolean') return value ? '✓ Enabled' : '✗ Disabled';

    if (typeof value === 'number') {
      if (this.isDurationKey(key)) {
        if (value === 0) return '0 (disabled)';
        if (value === -1) return 'Unlimited';
        return this.formatDuration(value);
      }

      if (this.isSizeKey(key)) {
        if (value === -1) return 'Unlimited';
        return this.formatBytes(value);
      }

      if (this.isPermissionKey(key)) {
        return `${value} (${this.toOctal(value)})`;
      }
    }

    return String(value);
  }

  private formatDuration(ns: number): string {
    const seconds = ns / 1_000_000_000;
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
    return `${(seconds / 86400).toFixed(1)}d`;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }

  private toOctal(num: number): string {
    return '0' + num.toString(8);
  }

  private isDurationKey(key: string): boolean {
    return /(Time|Interval|Wait|Back|Age|Ahead)$/i.test(key);
  }

  private isSizeKey(key: string): boolean {
    return /(Size|Space)$/i.test(key);
  }

  private isPermissionKey(key: string): boolean {
    return /(Perms|UID|GID|Umask)$/i.test(key);
  }

  private getOptionGroup(key: string, value: unknown): string {
    if (typeof value === 'boolean') return 'Booleans';
    if (typeof value === 'number') {
      if (this.isDurationKey(key)) return 'Durations';
      if (this.isSizeKey(key)) return 'Sizes';
      if (this.isPermissionKey(key)) return 'Permissions';
      return 'Numbers';
    }
    return 'Strings';
  }

  trackByCategory(_: number, category: { name: string }): string {
    return category.name;
  }

  trackByConfigKey(_: number, item: { key: string }): string {
    return item.key;
  }
}

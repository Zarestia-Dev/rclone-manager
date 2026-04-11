import {
  Component,
  inject,
  input,
  signal,
  computed,
  effect,
  ViewChild,
  untracked,
} from '@angular/core';

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

import {
  VfsList,
  VfsQueueItem,
  VfsService,
  VfsStats,
} from 'src/app/services/operations/vfs.service';
import { PathSelectionService } from 'src/app/services/remote/path-selection.service';
import { NotificationService } from '@app/services';
import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';
import {
  FileSystemService,
  MountManagementService,
  ServeManagementService,
  RemoteFacadeService,
  RcloneValueMapperService,
} from '@app/services';

interface VfsInstance {
  name: string;
  stats: VfsStats | null;
  queue: VfsQueueItem[];
  pollInterval: string;
}

const POLL_INTERVAL_MS = 5000;
const PRIORITY_EXPIRY = -999_999_999;
const DELAY_EXPIRY = 999_999_999;
const DELAY_SLIDER_DEFAULT = 60;

const INDEXED_VFS_RE = /:\[\d+\]$/;

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
  readonly remoteName = input.required<string>();

  private readonly vfsService = inject(VfsService);
  private readonly notification = inject(NotificationService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly mountService = inject(MountManagementService);
  private readonly serveService = inject(ServeManagementService);
  private readonly translate = inject(TranslateService);
  private readonly facade = inject(RemoteFacadeService);
  private readonly mapper = inject(RcloneValueMapperService);

  readonly remote = computed(() =>
    this.facade.activeRemotes().find(r => r.name === this.remoteName())
  );
  readonly changeNotify = computed(() => this.remote()?.features?.changeNotify ?? false);

  @ViewChild(MatTable) table?: MatTable<VfsQueueItem>;

  readonly vfsInstances = signal<VfsInstance[]>([]);
  readonly selectedVfs = signal<VfsInstance | null>(null);
  readonly loading = signal(false);
  readonly vfsNotFound = signal(false);
  readonly pollIntervalInput = signal('');
  readonly delaySliderValue = signal(DELAY_SLIDER_DEFAULT);
  readonly showDelaySlider = signal<number | null>(null);
  readonly showAdvancedConfig = signal(false);
  readonly configSearchTerm = signal('');

  readonly totalQueueSize = computed(
    () => this.selectedVfs()?.queue.reduce((sum, i) => sum + i.size, 0) ?? 0
  );
  readonly uploadingCount = computed(
    () => this.selectedVfs()?.queue.filter(i => i.uploading).length ?? 0
  );
  readonly isIndexedVfs = computed(() => {
    const name = this.selectedVfs()?.name;
    return name ? INDEXED_VFS_RE.test(name) : false;
  });
  readonly hasUsableVfs = computed(() => !!this.selectedVfs() && !this.isIndexedVfs());

  readonly vfsConfigGroups = computed(() => {
    const opts = this.selectedVfs()?.stats?.opt;
    if (!opts) return [];

    const searchTerm = this.configSearchTerm().toLowerCase();
    const grouped = new Map<string, { key: string; value: string; rawValue: unknown }[]>();
    const groupOrder = ['Booleans', 'Durations', 'Sizes', 'Permissions', 'Numbers', 'Strings'];

    for (const [key, rawValue] of Object.entries(opts)) {
      if (
        searchTerm &&
        !key.toLowerCase().includes(searchTerm) &&
        !String(rawValue).toLowerCase().includes(searchTerm)
      ) {
        continue;
      }
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

  readonly displayedColumns: string[] = ['name', 'size', 'status'];
  readonly isDetailRow = (_: number, row: VfsQueueItem): boolean =>
    this.showDelaySlider() === row.id;

  constructor() {
    // Reload when remote name changes.
    effect(() => {
      this.remoteName();
      untracked(() => void this.loadAll());
    });

    // Reload when mount or serve state changes (VFS list may have changed).
    effect(() => {
      this.mountService.mountedRemotes();
      this.serveService.runningServes();
      untracked(() => void this.loadAll());
    });

    // Sync poll interval input field when selection changes.
    effect(() => {
      const vfs = this.selectedVfs();
      if (vfs) this.pollIntervalInput.set(vfs.pollInterval);
    });

    // Force table re-render when delay slider row changes.
    effect(() => {
      this.showDelaySlider();
      this.table?.renderRows();
    });

    // Periodic stats/queue refresh while a usable VFS is selected.
    timer(POLL_INTERVAL_MS, POLL_INTERVAL_MS)
      .pipe(
        filter(() => !this.vfsNotFound() && this.hasUsableVfs()),
        switchMap(() => from(this.refreshStatsAndQueue())),
        retry({ delay: POLL_INTERVAL_MS }),
        takeUntilDestroyed()
      )
      .subscribe();
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

      // Merge with existing instances to prevent UI flicker on refresh.
      const currentMap = new Map(this.vfsInstances().map(i => [i.name, i]));
      const newInstances: VfsInstance[] = filteredNames.map(
        name => currentMap.get(name) ?? { name, stats: null, queue: [], pollInterval: '' }
      );

      this.vfsInstances.set(newInstances);
      this.vfsNotFound.set(false);

      const selected = this.selectedVfs();
      if (!selected || !filteredNames.includes(selected.name)) {
        this.selectedVfs.set(newInstances[0] ?? null);
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

  private filterVfsNames(names: string[]): string[] {
    const remote = this.remoteName();
    return names.filter(n => n === remote || n.startsWith(`${remote}:`));
  }

  async refreshStatsAndQueue(): Promise<void> {
    const selected = this.selectedVfs();
    if (!selected || this.isIndexedVfs()) return;

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
    if (!this.changeNotify()) return;

    const updated = await Promise.all(
      this.vfsInstances().map(async inst => {
        if (INDEXED_VFS_RE.test(inst.name)) return inst;
        try {
          const res = await this.vfsService.getPollInterval(inst.name);
          return res?.interval?.string ? { ...inst, pollInterval: res.interval.string } : inst;
        } catch {
          console.warn(`Failed to load poll interval for ${inst.name}`);
          return inst;
        }
      })
    );

    this.vfsInstances.set(updated);

    const selected = this.selectedVfs();
    if (selected) {
      const found = updated.find(i => i.name === selected.name);
      if (found) this.selectedVfs.set(found);
    }
  }

  readonly compareVfs = (o1: VfsInstance, o2: VfsInstance): boolean => o1?.name === o2?.name;

  // ============ Queue Actions ============

  async prioritizeUpload(item: VfsQueueItem): Promise<void> {
    await this.updateExpiry(
      item,
      PRIORITY_EXPIRY,
      this.translate.instant('shared.vfsControl.actions.messages.prioritized', { name: item.name })
    );
  }

  async delayUpload(item: VfsQueueItem): Promise<void> {
    await this.updateExpiry(
      item,
      DELAY_EXPIRY,
      this.translate.instant('shared.vfsControl.actions.messages.delayedSeconds', {
        seconds: DELAY_EXPIRY,
      })
    );
  }

  async setCustomDelay(item: VfsQueueItem): Promise<void> {
    const seconds = this.delaySliderValue();
    await this.updateExpiry(
      item,
      seconds,
      this.translate.instant('shared.vfsControl.actions.messages.delayedSeconds', { seconds })
    );
    this.showDelaySlider.set(null);
  }

  private async updateExpiry(item: VfsQueueItem, expiry: number, msg: string): Promise<void> {
    const fs = this.selectedVfs()?.name;
    if (!fs) return;
    try {
      await this.vfsService.setQueueExpiry(fs, item.id, expiry, false);
      this.notification.showInfo(msg);
      void this.refreshStatsAndQueue();
    } catch (e) {
      this.notification.showError(
        this.translate.instant('shared.vfsControl.actions.messages.actionFailed', { error: e }),
        'Close'
      );
    }
  }

  // ============ Cache Actions ============

  async forgetFile(path: string): Promise<void> {
    await this.performAction(async fs => {
      const res = await this.vfsService.forget(fs, path);
      return res.forgotten?.length
        ? this.translate.instant('shared.vfsControl.actions.messages.removed', { path })
        : this.translate.instant('shared.vfsControl.actions.messages.removeFailed');
    });
  }

  async clearMetadataCache(): Promise<void> {
    await this.performAction(async fs => {
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

  private async performAction(action: (fsName: string) => Promise<string>): Promise<void> {
    const fs = this.selectedVfs()?.name;
    if (!fs) return;
    try {
      const msg = await action(fs);
      this.notification.showInfo(msg);
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
    if (val < 60) return `${val}s`;
    if (val < 3600) return `${Math.floor(val / 60)}m`;
    return `${Math.floor(val / 3600)}h`;
  }

  getQueueItemStatus(item: VfsQueueItem): string {
    if (item.uploading)
      return this.translate.instant('shared.vfsControl.queue.statusText.uploading');
    if (item.expiry >= DELAY_EXPIRY - 1000)
      return this.translate.instant('shared.vfsControl.queue.statusText.delayed');
    if (item.expiry <= PRIORITY_EXPIRY + 1000)
      return this.translate.instant('shared.vfsControl.queue.statusText.ready');
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

  onVfsSelectionChange(vfs: VfsInstance | null): void {
    this.selectedVfs.set(vfs);
    void this.refreshStatsAndQueue();
  }

  trackByFn(_: number, item: VfsQueueItem): number {
    return item.id;
  }
  trackByVfsName(_: number, vfs: VfsInstance): string {
    return vfs.name;
  }
  trackByCategory(_: number, category: { name: string }): string {
    return category.name;
  }
  trackByConfigKey(_: number, item: { key: string }): string {
    return item.key;
  }

  // ============ Config Formatting ============

  formatOptionValue(key: string, value: unknown): string {
    if (value === null || value === undefined) return 'N/A';
    if (typeof value === 'boolean') {
      return value
        ? this.translate.instant('shared.vfsControl.advancedConfig.booleanEnabled')
        : this.translate.instant('shared.vfsControl.advancedConfig.booleanDisabled');
    }
    if (this.isDurationKey(key)) return this.mapper.machineToHuman(value, 'Duration');
    if (this.isSizeKey(key)) return this.mapper.machineToHuman(value, 'SizeSuffix');
    if (this.isPermissionKey(key)) return this.mapper.machineToHuman(value, 'FileMode');
    return String(value);
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
}

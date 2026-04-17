import { inject, Injectable, signal, computed, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { combineLatest } from 'rxjs';
import { AppSettingsService } from '@app/services';

/**
 * Owns all Nautilus view-state (layout, sort, icon size, show-hidden) and
 * handles persistence to/from AppSettingsService.
 */
@Injectable()
export class NautilusSettingsService {
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly destroyRef = inject(DestroyRef);

  // ── Icon size tables ────────────────────────────────────────────────────────
  readonly GRID_ICON_SIZES = [48, 64, 96, 128, 160, 256] as const;
  readonly LIST_ICON_SIZES = [16, 24, 32, 48] as const;

  // ── Writable state ──────────────────────────────────────────────────────────
  readonly layout = signal<'grid' | 'list'>('grid');
  readonly showHidden = signal(false);
  readonly iconSize = signal(96);
  readonly savedGridIconSize = signal<number | null>(null);
  readonly savedListIconSize = signal<number | null>(null);

  private readonly _sortColumn = signal<'name' | 'size' | 'modified'>('name');
  private readonly _sortAscending = signal(true);

  // ── Computeds ───────────────────────────────────────────────────────────────
  readonly sortKey = computed(
    () => `${this._sortColumn()}-${this._sortAscending() ? 'asc' : 'desc'}`
  );
  readonly sortDirection = computed((): 'asc' | 'desc' => (this._sortAscending() ? 'asc' : 'desc'));
  readonly listRowHeight = computed(() => this.iconSize() + 16);

  private readonly _currentIconSizes = computed(() =>
    this.layout() === 'list'
      ? (this.LIST_ICON_SIZES as readonly number[])
      : (this.GRID_ICON_SIZES as readonly number[])
  );
  readonly increaseIconDisabled = computed(
    () => this.iconSize() >= this._currentIconSizes().at(-1)!
  );
  readonly decreaseIconDisabled = computed(() => this.iconSize() <= this._currentIconSizes()[0]);

  constructor() {
    this._loadFromAppSettings();
  }

  // ── Sort ────────────────────────────────────────────────────────────────────

  /** Applies a sort from an encoded key (e.g. 'name-asc') without persisting. */
  applySort(key: string): void {
    const [col, dir] = key.split('-');
    this._sortColumn.set(col as 'name' | 'size' | 'modified');
    this._sortAscending.set(dir !== 'desc');
  }

  setSort(k: string): void {
    this.applySort(k);
    this.saveSortKey(k);
  }

  toggleSort(column: string): void {
    const col = column as 'name' | 'size' | 'modified';
    if (this._sortColumn() === col) {
      this._sortAscending.update(v => !v);
    } else {
      this._sortColumn.set(col);
      // Numeric columns default to descending (largest/most-recent first).
      this._sortAscending.set(col === 'name');
    }
    this.saveSortKey(this.sortKey());
  }

  // ── Layout ──────────────────────────────────────────────────────────────────

  setLayout(l: 'grid' | 'list'): void {
    this._persistIconSizeForCurrentLayout();
    this.layout.set(l);
    this.saveLayout(l);

    const savedSize = l === 'grid' ? this.savedGridIconSize() : this.savedListIconSize();
    if (savedSize) {
      this.iconSize.set(savedSize);
    } else {
      const sizes = l === 'grid' ? this.GRID_ICON_SIZES : this.LIST_ICON_SIZES;
      this.iconSize.set(sizes[Math.floor(sizes.length / 2)]);
    }
  }

  // ── Visibility ──────────────────────────────────────────────────────────────

  toggleShowHidden(v: boolean): void {
    this.showHidden.set(v);
    this.saveShowHidden(v);
  }

  // ── Icon size ────────────────────────────────────────────────────────────────

  increaseIconSize(): void {
    this._changeIconSize(1);
  }

  decreaseIconSize(): void {
    this._changeIconSize(-1);
  }

  // ── Persistence (public so callers like split-divider can invoke directly) ──

  saveLayout(l: 'grid' | 'list'): void {
    this.appSettingsService.saveSetting('nautilus', 'default_layout', l);
  }

  saveSortKey(k: string): void {
    this.appSettingsService.saveSetting('nautilus', 'sort_key', k);
  }

  saveShowHidden(v: boolean): void {
    this.appSettingsService.saveSetting('nautilus', 'show_hidden_items', v);
  }

  saveGridIconSize(size: number): void {
    this.appSettingsService.saveSetting('nautilus', 'grid_icon_size', size);
  }

  saveListIconSize(size: number): void {
    this.appSettingsService.saveSetting('nautilus', 'list_icon_size', size);
  }

  saveSplitDividerPos(pos: number): void {
    this.appSettingsService.saveSetting('nautilus', 'split_divider_pos', Math.round(pos));
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _loadFromAppSettings(): void {
    combineLatest([
      this.appSettingsService.selectSetting('nautilus.default_layout'),
      this.appSettingsService.selectSetting('nautilus.sort_key'),
      this.appSettingsService.selectSetting('nautilus.show_hidden_items'),
      this.appSettingsService.selectSetting('nautilus.grid_icon_size'),
      this.appSettingsService.selectSetting('nautilus.list_icon_size'),
    ])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([layout, sortKey, showHidden, gridIconSize, listIconSize]) => {
        if (layout?.value) this.layout.set(layout.value as 'grid' | 'list');
        if (sortKey?.value) this.applySort(sortKey.value);
        if (showHidden?.value !== undefined) this.showHidden.set(showHidden.value);
        if (gridIconSize?.value) this.savedGridIconSize.set(gridIconSize.value);
        if (listIconSize?.value) this.savedListIconSize.set(listIconSize.value);

        // Restore icon size for the current layout.
        const currentLayout = layout?.value ?? this.layout();
        const savedSize =
          currentLayout === 'grid' ? this.savedGridIconSize() : this.savedListIconSize();
        const sizes =
          currentLayout === 'grid'
            ? (this.GRID_ICON_SIZES as readonly number[])
            : (this.LIST_ICON_SIZES as readonly number[]);
        this.iconSize.set(savedSize ?? sizes[Math.floor(sizes.length / 2)]);
      });
  }

  private _changeIconSize(direction: 1 | -1): void {
    const sizes = this._currentIconSizes();
    const cur = this.iconSize();
    let idx = sizes.indexOf(cur);
    if (idx === -1) {
      idx = sizes.findIndex(s => s > cur);
      if (idx === -1) idx = sizes.length - 1;
    }
    this.iconSize.set(sizes[Math.max(0, Math.min(sizes.length - 1, idx + direction))]);
    this._persistIconSizeForCurrentLayout();
  }

  private _persistIconSizeForCurrentLayout(): void {
    const isGrid = this.layout() === 'grid';
    const size = this.iconSize();
    if (isGrid) {
      this.savedGridIconSize.set(size);
      this.saveGridIconSize(size);
    } else {
      this.savedListIconSize.set(size);
      this.saveListIconSize(size);
    }
  }
}

import { inject, Injectable, signal, computed } from '@angular/core';
import { LocalStorageService } from './state/local-storage.service';

/**
 * Owns all Nautilus view-state (layout, sort, icon size, show-hidden) and
 * handles persistence to/from LocalStorageService.
 */
@Injectable()
export class NautilusSettingsService {
  private readonly localStorage = inject(LocalStorageService);

  // ── Icon size tables ────────────────────────────────────────────────────────
  readonly GRID_ICON_SIZES = [48, 64, 96, 128, 160, 256] as const;
  readonly LIST_ICON_SIZES = [16, 24, 32, 48] as const;

  // ── Writable state ──────────────────────────────────────────────────────────
  readonly layout = signal<'grid' | 'list'>('grid');
  readonly showHidden = signal(false);
  readonly iconSize = signal(96);
  readonly savedGridIconSize = signal<number | null>(null);
  readonly savedListIconSize = signal<number | null>(null);
  readonly operationsPanelPosition = signal<'sidebar' | 'bottom'>('sidebar');
  readonly operationsPanelHeight = signal<number>(200);

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
  readonly increaseIconDisabled = computed(() => {
    const sizes = this._currentIconSizes();
    return this.iconSize() >= sizes[sizes.length - 1];
  });
  readonly decreaseIconDisabled = computed(() => this.iconSize() <= this._currentIconSizes()[0]);

  constructor() {
    this._loadFromLocalStorage();
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
      this.iconSize.set(sizes[Math.floor((sizes.length - 1) / 2)]);
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
    this.localStorage.set('nautilus.default_layout', l);
  }

  saveSortKey(k: string): void {
    this.localStorage.set('nautilus.sort_key', k);
  }

  saveShowHidden(v: boolean): void {
    this.localStorage.set('nautilus.show_hidden_items', v);
  }

  saveGridIconSize(size: number): void {
    this.localStorage.set('nautilus.grid_icon_size', size);
  }

  saveListIconSize(size: number): void {
    this.localStorage.set('nautilus.list_icon_size', size);
  }

  saveSplitDividerPos(pos: number): void {
    this.localStorage.set('nautilus.split_divider_pos', Math.round(pos));
  }

  saveOperationsPanelPosition(pos: 'sidebar' | 'bottom'): void {
    this.operationsPanelPosition.set(pos);
    this.localStorage.set('nautilus.operations_panel_pos', pos);
  }

  saveOperationsPanelHeight(height: number): void {
    this.operationsPanelHeight.set(height);
    this.localStorage.set('nautilus.operations_panel_height', height);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _loadFromLocalStorage(): void {
    const layout = this.localStorage.get<'grid' | 'list'>('nautilus.default_layout', 'grid');
    const sortKey = this.localStorage.get<string>('nautilus.sort_key', 'name-asc');
    const showHidden = this.localStorage.get<boolean>('nautilus.show_hidden_items', false);
    const gridIconSize = this.localStorage.get<number | null>('nautilus.grid_icon_size', null);
    const listIconSize = this.localStorage.get<number | null>('nautilus.list_icon_size', null);
    const operationsPanelPos = this.localStorage.get<'sidebar' | 'bottom'>(
      'nautilus.operations_panel_pos',
      'sidebar'
    );
    const operationsPanelHeight = this.localStorage.get<number>(
      'nautilus.operations_panel_height',
      200
    );

    this.layout.set(layout);
    this.applySort(sortKey);
    this.showHidden.set(showHidden);
    this.operationsPanelPosition.set(operationsPanelPos);
    this.operationsPanelHeight.set(operationsPanelHeight);
    if (gridIconSize) this.savedGridIconSize.set(gridIconSize);
    if (listIconSize) this.savedListIconSize.set(listIconSize);

    // Restore icon size for the current layout.
    const savedSize = layout === 'grid' ? gridIconSize : listIconSize;
    const sizes = layout === 'grid' ? this.GRID_ICON_SIZES : this.LIST_ICON_SIZES;
    this.iconSize.set(savedSize ?? sizes[Math.floor((sizes.length - 1) / 2)]);
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

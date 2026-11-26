import { inject, Injectable, signal, computed, effect, untracked } from '@angular/core';
import { LocalStorageService } from './state/local-storage.service';
import { AppSettingsService } from '../settings/app-settings.service';

/** Where each managed setting of the view was kept in this browser before it was managed. */
const LEGACY_KEYS: readonly (readonly [string, string])[] = [
  ['nautilus.default_layout', 'layout'],
  ['nautilus.sort_key', 'sort'],
  ['nautilus.show_hidden_items', 'show_hidden'],
  ['nautilus.grid_icon_size', 'grid_icon_size'],
  ['nautilus.list_icon_size', 'list_icon_size'],
  ['nautilus.sidebar_drive_order', 'sidebar_drive_order'],
  ['nautilus.sidebar_hidden_drives', 'sidebar_hidden_drives'],
];

/**
 * Owns all Nautilus view-state (layout, sort, icon size, show-hidden, sidebar) and keeps it in
 * the managed settings, so every window and browser shows the files the same way and a change
 * made in one reaches the others. Only the split divider stays in this browser: it suits the
 * width of its screen.
 */
@Injectable()
export class NautilusSettingsService {
  private readonly localStorage = inject(LocalStorageService);
  private readonly appSettings = inject(AppSettingsService);

  // ── Icon size tables ────────────────────────────────────────────────────────
  readonly GRID_ICON_SIZES = [48, 64, 96, 128, 160, 256] as const;
  readonly LIST_ICON_SIZES = [16, 24, 32, 48] as const;

  // ── Writable state ──────────────────────────────────────────────────────────
  readonly layout = signal<'grid' | 'list'>('grid');
  readonly showHidden = signal(false);
  /** Each layout keeps its own icon size; the defaults are those of the settings schema. */
  readonly savedGridIconSize = signal(96);
  readonly savedListIconSize = signal(24);

  readonly sidebarDriveOrder = signal<string[]>([]);
  readonly sidebarHiddenDrives = signal<Set<string>>(new Set());

  private readonly _sortColumn = signal<'name' | 'size' | 'modified'>('name');
  private readonly _sortAscending = signal(true);

  readonly sortColumn = this._sortColumn.asReadonly();
  readonly sortAscending = this._sortAscending.asReadonly();

  // ── Computeds ───────────────────────────────────────────────────────────────
  readonly iconSize = computed(() =>
    this.layout() === 'grid' ? this.savedGridIconSize() : this.savedListIconSize()
  );
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
    // Each stored value is applied when it loads or changes, here or in another window.
    const follow = <T>(key: string, apply: (value: T) => void): void => {
      const value = computed(() => this.appSettings.options()?.[`nautilus.${key}`]?.value as T);
      effect(() => {
        const current = value();
        if (current !== undefined && current !== null) untracked(() => apply(current));
      });
    };
    follow<'grid' | 'list'>('layout', value => this.layout.set(value));
    follow<string>('sort', value => this.applySort(value));
    follow<boolean>('show_hidden', value => this.showHidden.set(value));
    follow<number>('grid_icon_size', value => this.savedGridIconSize.set(value));
    follow<number>('list_icon_size', value => this.savedListIconSize.set(value));
    follow<string[]>('sidebar_drive_order', value => this.sidebarDriveOrder.set(value));
    follow<string[]>('sidebar_hidden_drives', value =>
      this.sidebarHiddenDrives.set(new Set(value))
    );

    const migration = effect(() => {
      if (!this.appSettings.options()) return;
      untracked(() => this._moveLegacySettings());
      migration.destroy();
    });
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
    this._save('sort', k);
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
    this._save('sort', this.sortKey());
  }

  // ── Layout ──────────────────────────────────────────────────────────────────

  setLayout(l: 'grid' | 'list'): void {
    this.layout.set(l);
    this._save('layout', l);
  }

  // ── Visibility ──────────────────────────────────────────────────────────────

  toggleShowHidden(v: boolean): void {
    this.showHidden.set(v);
    this._save('show_hidden', v);
  }

  // ── Icon size ────────────────────────────────────────────────────────────────

  increaseIconSize(): void {
    this._changeIconSize(1);
  }

  decreaseIconSize(): void {
    this._changeIconSize(-1);
  }

  // ── Persistence (public so callers like split-divider can invoke directly) ──

  saveSplitDividerPos(pos: number): void {
    this.localStorage.set('nautilus.split_divider_pos', Math.round(pos));
  }

  saveSidebarConfig(order: string[], hidden: string[]): void {
    this.sidebarDriveOrder.set(order);
    this.sidebarHiddenDrives.set(new Set(hidden));
    this._save('sidebar_drive_order', order);
    this._save('sidebar_hidden_drives', hidden);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** The view changes at once; a save that fails (a locked vault) only loses the setting. */
  private _save(key: string, value: unknown): void {
    this.appSettings.saveSetting('nautilus', key, value).catch(error => {
      console.warn(`[NautilusSettings] Cannot save nautilus.${key}:`, error);
    });
  }

  /** Moves what this browser kept of the view before it was managed into the settings. */
  private _moveLegacySettings(): void {
    for (const [legacy, key] of LEGACY_KEYS) {
      const value = this.localStorage.get<unknown>(legacy, null);
      if (value === null) continue;
      this.localStorage.remove(legacy);
      this._save(key, value);
    }
  }

  private _changeIconSize(direction: 1 | -1): void {
    const sizes = this._currentIconSizes();
    const cur = this.iconSize();
    let idx = sizes.indexOf(cur);
    if (idx === -1) {
      idx = sizes.findIndex(s => s > cur);
      if (idx === -1) idx = sizes.length - 1;
    }
    const size = sizes[Math.max(0, Math.min(sizes.length - 1, idx + direction))];
    if (this.layout() === 'grid') {
      this.savedGridIconSize.set(size);
      this._save('grid_icon_size', size);
    } else {
      this.savedListIconSize.set(size);
      this._save('list_icon_size', size);
    }
  }
}

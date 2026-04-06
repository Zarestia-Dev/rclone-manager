// It handles tabs, split-view navigation, and rich file operations.
import {
  Component,
  inject,
  OnInit,
  ViewChild,
  signal,
  computed,
  HostListener,
  effect,
  untracked,
  DestroyRef,
  WritableSignal,
  output,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { combineLatest, EMPTY, firstValueFrom, from, fromEvent, of } from 'rxjs';
import { catchError, map, startWith, switchMap } from 'rxjs/operators';

import { MatIconModule } from '@angular/material/icon';
import { MatSidenav, MatSidenavModule } from '@angular/material/sidenav';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatDialog } from '@angular/material/dialog';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';

// CDK
import { CdkMenuModule } from '@angular/cdk/menu';

// Services & Types
import {
  AppSettingsService,
  NautilusService,
  PathSelectionService,
  RemoteFileOperationsService,
  RemoteFacadeService,
  IconService,
  NotificationService,
  getRemoteNameFromFs,
} from '@app/services';
import {
  Entry,
  ExplorerRoot,
  STANDARD_MODAL_SIZE,
  FileBrowserItem,
  FilePickerConfig,
  RemoteFeatures,
} from '@app/types';

import { FormatFileSizePipe } from '@app/pipes';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import { isLocalPath } from 'src/app/services/remote/utils/remote-config.utils';

import { InputModalComponent } from 'src/app/shared/modals/input-modal/input-modal.component';
import { RemoteAboutModalComponent } from '../../features/modals/remote/remote-about-modal.component';
import { PropertiesModalComponent } from '../../features/modals/properties/properties-modal.component';
import { KeyboardShortcutsModalComponent } from '../../features/modals/settings/keyboard-shortcuts-modal/keyboard-shortcuts-modal.component';
import { NautilusSidebarComponent } from './sidebar/nautilus-sidebar.component';
import { NautilusToolbarComponent } from './toolbar/nautilus-toolbar.component';
import { NautilusTabsComponent } from './tabs/nautilus-tabs.component';
import { NautilusViewPaneComponent } from './view-pane/nautilus-view-pane.component';
import { NautilusBottomBarComponent } from './bottom-bar/nautilus-bottom-bar.component';
import { TabItem } from './tabs/nautilus-tabs.component';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface PaneState {
  remote: ExplorerRoot | null;
  path: string;
  selection: Set<string>;
  history: { remote: ExplorerRoot | null; path: string }[];
  historyIndex: number;
  rawFiles: WritableSignal<FileBrowserItem[]>;
  isLoading: WritableSignal<boolean>;
  error: WritableSignal<string | null>;
  refreshTrigger: WritableSignal<number>;
}

interface Tab {
  id: number;
  title: string;
  left: PaneState;
  right?: PaneState;
}

interface UndoEntry {
  mode: 'copy' | 'move';
  items: {
    srcRemote: string;
    srcPath: string;
    dstRemote: string;
    dstFullPath: string;
    isDir: boolean;
    name: string;
  }[];
}

/** Signals for a specific pane, resolved by index. */
interface PaneRef {
  remote: WritableSignal<ExplorerRoot | null>;
  path: WritableSignal<string>;
  selection: WritableSignal<Set<string>>;
  rawFiles: WritableSignal<FileBrowserItem[]>;
  loading: WritableSignal<boolean>;
  error: WritableSignal<string | null>;
  refreshTrigger: WritableSignal<number>;
}

/** View-model snapshot passed to each <app-nautilus-view-pane>. */
export interface PaneViewModel {
  index: 0 | 1;
  files: FileBrowserItem[];
  selection: Set<string>;
  loading: boolean;
  error: string | null;
  starredMode: boolean;
}

/** Payload for native HTML5 Drag & Drop inter-component communication. */
export interface NautilusDragPayload {
  items: FileBrowserItem[];
  sourcePaneIndex: 0 | 1;
}

export const NAUTILUS_DRAG_MIME_TYPE = 'application/nautilus-files';

interface ExternalDropFile {
  file: File;
  relativePath: string;
}

const isTauriRuntime = (): boolean =>
  typeof window !== 'undefined' &&
  !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

const DEFAULT_PICKER_OPTIONS: FilePickerConfig = {
  mode: 'both',
  selection: 'both',
  multi: false,
  minSelection: 0,
};

@Component({
  selector: 'app-nautilus',
  standalone: true,
  imports: [
    NautilusSidebarComponent,
    NautilusToolbarComponent,
    NautilusTabsComponent,
    NautilusViewPaneComponent,
    NautilusBottomBarComponent,
    TranslateModule,
    MatIconModule,
    MatSidenavModule,
    MatButtonModule,
    MatDividerModule,
    MatRadioModule,
    MatCheckboxModule,
    CdkMenuModule,
  ],
  providers: [FormatFileSizePipe],
  templateUrl: './nautilus.component.html',
  styleUrl: './nautilus.component.scss',
})
export class NautilusComponent implements OnInit {
  private static readonly HOVER_OPEN_DELAY_MS = 1000;
  private static readonly MAX_UNDO_STACK = 20;
  private readonly LIST_ICON_SIZES = [16, 24, 32, 48];
  private readonly GRID_ICON_SIZES = [48, 64, 96, 128, 160, 256];

  private readonly destroyRef = inject(DestroyRef);
  private readonly translate = inject(TranslateService);
  protected readonly iconService = inject(IconService);
  private readonly notificationService = inject(NotificationService);
  private readonly nautilusService = inject(NautilusService);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly fileViewerService = inject(FileViewerService);
  private readonly remoteFacadeService = inject(RemoteFacadeService);
  private readonly dialog = inject(MatDialog);
  private readonly formatFileSizePipe = inject(FormatFileSizePipe);

  public readonly closeOverlay = output<void>();

  @ViewChild('sidenav') sidenav!: MatSidenav;

  private readonly _windowWidth = toSignal(
    fromEvent(window, 'resize').pipe(
      map(() => window.innerWidth),
      startWith(window.innerWidth)
    ),
    { initialValue: window.innerWidth }
  );
  protected readonly isMobile = computed(() => this._windowWidth() < 680);
  protected readonly isSidenavOpen = signal(!this.isMobile());
  protected readonly isDragging = signal(false);
  protected readonly sidenavMode = computed(() => (this.isMobile() ? 'over' : 'side'));
  private readonly initialLocationApplied = signal(false);

  private readonly _langChange = toSignal(this.translate.onLangChange.pipe(startWith(null)));

  private readonly filePickerState = this.nautilusService.filePickerState;
  protected readonly isPickerMode = computed(() => this.filePickerState().isOpen);
  protected readonly pickerOptions = computed(
    (): FilePickerConfig => this.filePickerState().options ?? DEFAULT_PICKER_OPTIONS
  );
  protected readonly isConfirmDisabled = computed(() => {
    if (!this.isPickerMode()) return false;
    const opts = this.pickerOptions();
    const count = this.selectedItems().size;
    if (opts.selection === 'files' && count === 0) return true;
    return count < (opts.minSelection ?? 0);
  });

  protected readonly title = computed(() => {
    const state = this.filePickerState();
    if (!state.isOpen) return 'nautilus.titles.files';
    const sel = state.options?.selection;
    if (sel === 'folders') return 'nautilus.titles.selectFolder';
    if (sel === 'files') return 'nautilus.titles.selectFile';
    return 'nautilus.titles.selectItems';
  });

  protected readonly layout = signal<'grid' | 'list'>('grid');
  protected readonly showHidden = signal(false);

  private readonly _sortColumn = signal<'name' | 'size' | 'modified'>('name');
  private readonly _sortAscending = signal(true);
  protected readonly sortKey = computed(
    () => `${this._sortColumn()}-${this._sortAscending() ? 'asc' : 'desc'}`
  );
  protected readonly sortDirection = computed(() => (this._sortAscending() ? 'asc' : 'desc'));

  protected readonly starredMode = computed(
    () => this.nautilusRemote() === null && this.currentPath() === ''
  );
  protected readonly starredModeRight = computed(
    () => this.nautilusRemoteRight() === null && this.currentPathRight() === ''
  );
  protected readonly activeStarredMode = computed(() =>
    this.activePaneIndex() === 0 ? this.starredMode() : this.starredModeRight()
  );

  private readonly savedGridIconSize = signal<number | null>(null);
  private readonly savedListIconSize = signal<number | null>(null);
  protected readonly iconSize = signal(96);

  private readonly currentIconSizes = computed(() =>
    this.layout() === 'list' ? this.LIST_ICON_SIZES : this.GRID_ICON_SIZES
  );

  protected readonly listRowHeight = computed(() => this.iconSize() + 16);

  protected readonly hoveredTabIndex = signal<number | null>(null);
  protected readonly hoveredSidebarItem = signal<string | null>(null);
  protected readonly hoveredFolder = signal<FileBrowserItem | null>(null);
  protected readonly hoveredSegmentIndex = signal<number | null>(null);
  private _lastDragHitKey = '';
  private _dragCounter = 0;
  private _hoverOpenTimer: ReturnType<typeof setTimeout> | null = null;
  private _hoverOpenKey = '';
  private _draggedItems: FileBrowserItem[] = [];
  private desktopDropUnlisten: (() => void) | null = null;

  protected readonly nautilusRemote = signal<ExplorerRoot | null>(null);
  protected readonly currentPath = signal<string>('');
  private readonly refreshTrigger = signal(0);
  protected readonly rawFiles = signal<FileBrowserItem[]>([]);
  protected readonly errorState = signal<string | null>(null);
  protected readonly isLoading = signal(false);

  protected readonly nautilusRemoteRight = signal<ExplorerRoot | null>(null);
  protected readonly currentPathRight = signal<string>('');
  private readonly refreshTriggerRight = signal(0);
  protected readonly isLoadingRight = signal(false);
  protected readonly errorStateRight = signal<string | null>(null);
  protected readonly rawFilesRight = signal<FileBrowserItem[]>([]);

  protected readonly selectedItems = signal<Set<string>>(new Set());
  protected readonly selectedItemsRight = signal<Set<string>>(new Set());
  private lastSelectedIndex: number | null = null;

  protected readonly clipboardItems = signal<
    { remote: string; path: string; name: string; isDir: boolean }[]
  >([]);
  protected readonly clipboardMode = signal<'copy' | 'cut' | null>(null);
  protected readonly hasClipboard = computed(() => this.clipboardItems().length > 0);
  protected readonly cutItemPaths = computed(() => {
    if (this.clipboardMode() !== 'cut') return new Set<string>();
    return new Set(this.clipboardItems().map(item => `${item.remote}:${item.path}`));
  });

  private readonly _undoStack = signal<UndoEntry[]>([]);
  private readonly _redoStack = signal<UndoEntry[]>([]);
  protected readonly canUndo = computed(() => this._undoStack().length > 0);
  protected readonly canRedo = computed(() => this._redoStack().length > 0);

  protected readonly pathSegments = computed(() => {
    const path = this.activePath();
    if (!path) return [];
    const parts = path.split('/').filter(Boolean);
    return parts.map((name, i) => ({
      name,
      path: parts.slice(0, i + 1).join('/'),
    }));
  });

  protected readonly isEditingPath = signal(false);
  protected readonly isSearchMode = signal(false);
  protected readonly searchFilter = signal('');

  private interfaceTabCounter = 0;
  protected readonly tabs = signal<Tab[]>([]);
  protected readonly activeTabIndex = signal(0);

  protected readonly mappedTabs = computed((): TabItem[] =>
    this.tabs().map(tab => ({
      id: tab.id,
      title: tab.title,
      path: tab.left.path,
      remote: tab.left.remote ? { name: tab.left.remote.name, label: tab.left.remote.label } : null,
    }))
  );

  protected readonly activePaneIndex = signal<0 | 1>(0);
  protected readonly activeRemote = computed(() =>
    this.activePaneIndex() === 0 ? this.nautilusRemote() : this.nautilusRemoteRight()
  );
  protected readonly activePath = computed(() =>
    this.activePaneIndex() === 0 ? this.currentPath() : this.currentPathRight()
  );
  protected readonly activeFiles = computed(() =>
    this.activePaneIndex() === 0 ? this.files() : this.filesRight()
  );
  protected readonly activeIsLoading = computed(() =>
    this.activePaneIndex() === 0 ? this.isLoading() : this.isLoadingRight()
  );
  protected readonly activeErrorState = computed(() =>
    this.activePaneIndex() === 0 ? this.errorState() : this.errorStateRight()
  );

  protected readonly bottomBarOffset = computed(() =>
    this.isMobile() || this.isPickerMode() ? '64px' : '4px'
  );

  protected readonly canGoBack = computed(() => {
    const tab = this.tabs()[this.activeTabIndex()];
    if (!tab) return false;
    const pane = this.activePaneIndex() === 0 ? tab.left : tab.right;
    return pane ? pane.historyIndex > 0 : false;
  });
  protected readonly canGoForward = computed(() => {
    const tab = this.tabs()[this.activeTabIndex()];
    if (!tab) return false;
    const pane = this.activePaneIndex() === 0 ? tab.left : tab.right;
    return pane ? pane.historyIndex < pane.history.length - 1 : false;
  });

  protected readonly splitDividerPos = signal(50);
  protected readonly isSplitEnabled = computed(() => !!this.tabs()[this.activeTabIndex()]?.right);

  protected readonly splitGridColumns = computed(() =>
    this.isSplitEnabled() ? `${this.splitDividerPos()}% 0.5rem 1fr` : '1fr'
  );

  protected readonly bookmarks = this.nautilusService.bookmarks;

  protected readonly filteredBookmarks = computed(() => {
    const marks = this.bookmarks();
    if (!this.isPickerMode()) return marks;
    const cfg = this.pickerOptions();
    return marks.filter(b => {
      if (cfg.mode === 'local' && !b.meta.isLocal) return false;
      if (cfg.mode === 'remote' && b.meta.isLocal) return false;
      if (cfg.allowedRemotes?.length && !b.meta.isLocal) {
        return cfg.allowedRemotes.includes(
          this.pathSelectionService.normalizeRemoteName(b.meta.remote ?? '')
        );
      }
      return true;
    });
  });

  protected readonly localDrives = computed<ExplorerRoot[]>(() => {
    const drives = this.nautilusService.localDrives();
    if (this.isPickerMode() && this.pickerOptions().mode === 'remote') return [];
    return drives;
  });

  protected readonly cloudRemotes = computed<ExplorerRoot[]>(() => {
    let list = this.nautilusService.cloudRemotes();
    if (this.isPickerMode() && this.pickerOptions().mode === 'local') return [];
    const allowed = this.pickerOptions().allowedRemotes;
    if (this.isPickerMode() && allowed?.length) {
      list = list.filter(r => allowed.includes(r.name));
    }
    return list;
  });

  protected readonly allRemotesLookup = computed(() => [
    ...this.localDrives(),
    ...this.cloudRemotes(),
  ]);

  protected readonly fullPathInput = computed(() => {
    if (this.activeStarredMode()) return '';
    const remote = this.activeRemote();
    const path = this.activePath();
    if (!remote) return path;
    if (remote.isLocal) {
      const sep = remote.name.endsWith('/') ? '' : '/';
      return path ? `${remote.name}${sep}${path}` : remote.name;
    }
    const prefix = remote.name.includes(':') ? remote.name : `${remote.name}:`;
    const cleanPath = path.startsWith('/') ? path.substring(1) : path;
    return path ? `${prefix}${cleanPath}` : prefix;
  });

  private getPaneFiles(paneIndex: number): FileBrowserItem[] {
    const isStarred = paneIndex === 0 ? this.starredMode() : this.starredModeRight();
    const rawFiles = paneIndex === 0 ? this.rawFiles() : this.rawFilesRight();
    const cfg = this.pickerOptions();
    const isPicker = this.isPickerMode();

    let files: FileBrowserItem[];

    if (isStarred) {
      files = this.nautilusService.starredItems();
      if (isPicker) {
        files = files.filter(i => {
          if (cfg.mode === 'local' && !i.meta.isLocal) return false;
          if (cfg.mode === 'remote' && i.meta.isLocal) return false;
          if (cfg.allowedRemotes?.length && !i.meta.isLocal) {
            return cfg.allowedRemotes.includes(
              this.pathSelectionService.normalizeRemoteName(i.meta.remote ?? '')
            );
          }
          return true;
        });
      }
    } else {
      files = rawFiles;
    }

    if (!this.showHidden() && !isStarred) {
      files = files.filter(f => !f.entry.Name.startsWith('.'));
    }

    const search = this.searchFilter().toLowerCase().trim();
    if (search) {
      files = files.filter(f => f.entry.Name.toLowerCase().includes(search));
    }

    return this.sortFiles(files);
  }

  protected readonly files = computed(() => this.getPaneFiles(0));
  protected readonly filesRight = computed(() => this.getPaneFiles(1));

  private sortFiles(files: FileBrowserItem[]): FileBrowserItem[] {
    const list = [...files];
    const sort = this._sortColumn();
    const multiplier = this._sortAscending() ? 1 : -1;

    // Cache date parsing within each sort run to avoid repeated Date construction.
    const timeCache = new Map<string, number>();
    const getTime = (modTime: string): number => {
      let t = timeCache.get(modTime);
      if (t === undefined) {
        t = new Date(modTime).getTime();
        timeCache.set(modTime, t);
      }
      return t;
    };

    return list.sort((a, b) => {
      if (a.entry.IsDir !== b.entry.IsDir) return a.entry.IsDir ? -1 : 1;

      const aHidden = a.entry.Name.startsWith('.');
      const bHidden = b.entry.Name.startsWith('.');
      if (aHidden !== bHidden) return aHidden ? 1 : -1;

      switch (sort) {
        case 'name':
          return (
            a.entry.Name.localeCompare(b.entry.Name, undefined, { numeric: true }) * multiplier
          );
        case 'size':
          return (a.entry.Size - b.entry.Size) * multiplier;
        case 'modified':
          return (getTime(a.entry.ModTime) - getTime(b.entry.ModTime)) * multiplier;
        default:
          return 0;
      }
    });
  }

  protected readonly visiblePanes = computed((): PaneViewModel[] => {
    const left: PaneViewModel = {
      index: 0,
      files: this.files(),
      selection: this.selectedItems(),
      loading: this.isLoading(),
      error: this.errorState(),
      starredMode: this.starredMode(),
    };
    if (!this.isSplitEnabled()) return [left];
    return [
      left,
      {
        index: 1,
        files: this.filesRight(),
        selection: this.selectedItemsRight(),
        loading: this.isLoadingRight(),
        error: this.errorStateRight(),
        starredMode: this.starredModeRight(),
      },
    ];
  });

  protected readonly contextMenuItem = signal<FileBrowserItem | null>(null);

  protected readonly sortOptions = [
    { key: 'name-asc', label: 'nautilus.sort.az' },
    { key: 'name-desc', label: 'nautilus.sort.za' },
    { key: 'modified-desc', label: 'nautilus.sort.lastModified' },
    { key: 'modified-asc', label: 'nautilus.sort.firstModified' },
    { key: 'size-desc', label: 'nautilus.sort.sizeLargest' },
    { key: 'size-asc', label: 'nautilus.sort.sizeSmallest' },
  ];

  /**
   * Reactive selection summary. Tracks `_langChange` so this re-evaluates
   * whenever the active language switches (translate.instant is not observable).
   */
  protected readonly selectionSummary = computed(() => {
    this._langChange(); // reactive dependency — re-run on language change

    const selectedPaths = this.selectedItems();
    const count = selectedPaths.size;
    if (count === 0) return '';

    const allFiles = this.files();
    const selected = allFiles.filter(item => selectedPaths.has(this.getItemKey(item)));

    if (count === 1) {
      const item = selected[0];
      if (!item) return '';
      const name = `"${item.entry.Name}"`;
      const sel = this.translate.instant('nautilus.selection.selected');
      if (item.entry.IsDir) return `${name} ${sel}`;
      const size = this.formatFileSizePipe.transform(item.entry.Size);
      return `${name} ${sel} (${size})`;
    }

    const folders = selected.filter(i => i.entry.IsDir);
    const fileItems = selected.filter(i => !i.entry.IsDir);
    const parts: string[] = [];
    const sel = this.translate.instant('nautilus.selection.selected');

    if (folders.length > 0) {
      const label = this.translate.instant(
        folders.length > 1 ? 'nautilus.selection.folders' : 'nautilus.selection.folder'
      );
      parts.push(`${folders.length} ${label} ${sel}`);
    }

    if (fileItems.length > 0) {
      const totalSize = fileItems.reduce((s, f) => s + f.entry.Size, 0);
      const formattedSize = this.formatFileSizePipe.transform(totalSize);
      const label = this.translate.instant(
        folders.length > 0
          ? 'nautilus.selection.otherItems'
          : fileItems.length > 1
            ? 'nautilus.selection.items'
            : 'nautilus.selection.item'
      );
      parts.push(`${fileItems.length} ${label} ${sel} (${formattedSize})`);
    }

    return parts.join(', ');
  });

  constructor() {
    this.setupEffects();
    this.subscribeToSettings();
    this.loadFilesForPane(0);
    this.loadFilesForPane(1);
    void this.setupDesktopNativeDropListener();

    this.destroyRef.onDestroy(() => {
      this.desktopDropUnlisten?.();
      this.desktopDropUnlisten = null;
      this.nautilusService.setWindowTitle('RClone Manager');
    });
  }

  // ---------------------------------------------------------------------------
  // Pane signal accessor helper
  // ---------------------------------------------------------------------------

  private getPaneRef(paneIndex: 0 | 1): PaneRef {
    const isLeft = paneIndex === 0;
    return {
      remote: isLeft ? this.nautilusRemote : this.nautilusRemoteRight,
      path: isLeft ? this.currentPath : this.currentPathRight,
      selection: isLeft ? this.selectedItems : this.selectedItemsRight,
      rawFiles: isLeft ? this.rawFiles : this.rawFilesRight,
      loading: isLeft ? this.isLoading : this.isLoadingRight,
      error: isLeft ? this.errorState : this.errorStateRight,
      refreshTrigger: isLeft ? this.refreshTrigger : this.refreshTriggerRight,
    };
  }

  // ---------------------------------------------------------------------------
  // File loading — proper zoneless pattern
  // ---------------------------------------------------------------------------

  private loadFilesForPane(paneIndex: 0 | 1): void {
    const ref = this.getPaneRef(paneIndex);

    const loadParams = computed(() => ({
      remote: ref.remote(),
      path: ref.path(),
      _trigger: ref.refreshTrigger(), // included only to track refresh
    }));

    toObservable(loadParams)
      .pipe(
        switchMap(({ remote, path }) => {
          if (!remote) {
            ref.rawFiles.set([]);
            return EMPTY;
          }

          ref.loading.set(true);
          ref.error.set(null);

          const fsName = remote.isLocal
            ? remote.name
            : this.pathSelectionService.normalizeRemoteForRclone(remote.name);

          return from(this.remoteOps.getRemotePaths(fsName, path, {}, 'nautilus')).pipe(
            map(res =>
              (res.list || []).map(
                f =>
                  ({
                    entry: f,
                    meta: {
                      remote: this.pathSelectionService.normalizeRemoteName(fsName),
                      isLocal: remote.isLocal,
                      remoteType: remote.type,
                    },
                  }) as FileBrowserItem
              )
            ),
            catchError(err => {
              console.error('Error fetching files:', err);
              const msg = this.translate.instant('nautilus.errors.loadFailed');
              ref.error.set(err?.message ?? msg);
              this.notificationService.showError(msg);
              ref.loading.set(false);
              return of([]);
            })
          );
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(files => {
        ref.loading.set(false);
        ref.rawFiles.set(files);

        // Sync back into the active tab's PaneState so switching tabs restores
        // the last loaded state without a redundant network request.
        const activeTabId = this.tabs()[this.activeTabIndex()]?.id;
        const tab = this.tabs().find(t => t.id === activeTabId);
        if (tab) {
          const pane = paneIndex === 0 ? tab.left : tab.right;
          if (pane) {
            pane.rawFiles.set(files);
            pane.error.set(ref.error());
            pane.isLoading.set(false);
          }
        }
      });
  }

  async ngOnInit(): Promise<void> {
    await this.setupInitialTab();
  }

  private setupEffects(): void {
    effect(() => {
      this.isSidenavOpen.set(!this.isMobile());
    });

    // Fallback: apply initialLocation if remote data wasn't ready during setupInitialTab.
    effect(() => {
      const open = this.isPickerMode();
      const applied = this.initialLocationApplied();
      const cfg = this.pickerOptions();

      if (open && !applied && cfg.initialLocation) {
        if (!this.isDataReadyForConfig(cfg)) return;
        if (this.isLocationAllowedByConfig(cfg.initialLocation, cfg)) {
          this.navigateToPath(cfg.initialLocation);
          this.initialLocationApplied.set(true);
        }
      }

      if (!open && applied) this.initialLocationApplied.set(false);
    });

    // Handle dynamic remote selection (e.g. from Tray or external actions).
    effect(() => {
      const selectedMap = this.nautilusService.selectedNautilusRemote();
      if (selectedMap) {
        untracked(() => {
          const remote = this.allRemotesLookup().find(r => r.name === selectedMap);
          if (remote && this.tabs().length > 0) {
            this.selectRemote(remote);
            this.nautilusService.selectedNautilusRemote.set(null);
          }
        });
      }
    });

    // Handle dynamic path navigation (e.g. from Debug menu).
    effect(() => {
      const targetPath = this.nautilusService.targetPath();
      if (targetPath) {
        untracked(() => {
          const parsed = this.parseLocationToRemoteAndPath(targetPath);
          if (parsed && this.tabs().length > 0) {
            this._navigate(parsed.remote, parsed.path, true);
            this.nautilusService.targetPath.set(null);
          }
        });
      }
    });

    // URL Sync Effect (Sync navigate to URL path for Neat URLs)
    effect(() => {
      if (this.isPickerMode()) return;

      const remote = this.activeRemote();
      const path = this.activePath();
      const isOpen = this.nautilusService.isNautilusOverlayOpen();
      const isStandalone = this.nautilusService.isStandaloneWindow();

      untracked(() => {
        let newPath = '/';

        // Only set nautilus path if we are actually in nautilus (overlay open or standalone window)
        if (isOpen || isStandalone) {
          if (remote) {
            const encodedRemote = encodeURIComponent(remote.name);
            const segmentPath = path ? `/${path}` : '';
            newPath = `/nautilus/${encodedRemote}${segmentPath}`;
          } else {
            newPath = '/nautilus';
          }
        }

        // Only update if it actually changed
        const currentPath = window.location.pathname;
        if (currentPath !== newPath) {
          const newUrl = newPath + window.location.search;
          window.history.replaceState(null, '', newUrl);
        }
      });
    });

    // Window Title Effect: Updates the window title (browser or Tauri) based on active location.
    effect(() => {
      const isPicker = this.isPickerMode();
      const remote = this.activeRemote();
      const path = this.activePath();
      const starred = this.activeStarredMode();

      // Explicitly react to language changes.
      this._langChange();

      const appSuffix = 'RClone Browser';
      let segment: string;

      if (isPicker) {
        segment = this.translate.instant(this.title());
      } else if (starred) {
        segment = this.translate.instant('nautilus.titles.starred');
      } else if (remote) {
        const remoteLabel = this.translate.instant(remote.label || remote.name);
        if (path) {
          const lastSegment = path.split('/').filter(Boolean).pop() || path;
          segment = lastSegment;
        } else {
          segment = remoteLabel;
        }
      } else {
        // If at root level with no remote selected
        segment = this.translate.instant('nautilus.titles.files');
      }

      // Always manage the title if we have a segment.
      const fullTitle = segment ? `${segment} - ${appSuffix}` : appSuffix;

      this.nautilusService.setWindowTitle(fullTitle);
    });
  }

  private async setupInitialTab(): Promise<void> {
    await this.nautilusService.loadRemoteData();
    const pickerState = this.filePickerState();
    let initialRemote: ExplorerRoot | null = null;
    let initialPath = '';

    const tryParse = (loc: string): boolean => {
      const parsed = this.parseLocationToRemoteAndPath(loc);
      if (parsed) {
        initialRemote = parsed.remote;
        initialPath = parsed.path;
        return true;
      }
      return false;
    };

    // Priority 1: Picker initial location
    const cfg = pickerState.options;
    const loc = cfg?.initialLocation;
    if (pickerState.isOpen && cfg && loc) {
      if (
        this.isDataReadyForConfig(cfg) &&
        this.isLocationAllowedByConfig(loc, cfg) &&
        tryParse(loc)
      ) {
        this.initialLocationApplied.set(true);
      }
    }

    // Priority 2: Service-level overrides (Debug/Tray)
    if (!initialRemote) {
      const targetPath = this.nautilusService.targetPath();
      if (targetPath && tryParse(targetPath)) {
        this.nautilusService.targetPath.set(null);
      } else {
        const requestedName = this.nautilusService.selectedNautilusRemote();
        if (requestedName) {
          initialRemote = this.allRemotesLookup().find(r => r.name === requestedName) || null;
          this.nautilusService.selectedNautilusRemote.set(null);
        }
      }
    }

    // Priority 3: Picker mode defaults
    if (!initialRemote && pickerState.isOpen && pickerState.options) {
      const opts = pickerState.options;
      const drives = this.nautilusService.localDrives();
      const remotes = this.cloudRemotes();
      if (opts.mode === 'remote') {
        initialRemote =
          (opts.allowedRemotes?.length
            ? remotes.find(r => opts.allowedRemotes?.includes(r.name))
            : remotes[0]) || null;
      } else {
        initialRemote = drives[0] || null;
      }
    }

    // Priority 4: Standard fallback
    initialRemote ??= this.nautilusService.localDrives()[0] || null;

    this.createTab(initialRemote, initialPath);
  }

  private parseLocationToRemoteAndPath(
    rawInput: string
  ): { remote: ExplorerRoot; path: string } | null {
    let normalized = rawInput.replace(/\\/g, '/');
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    const known = this.allRemotesLookup();

    // Local Drive Match (Windows C:\ or mounted drives)
    const driveMatch = known.find(
      r => r.isLocal && normalized.toLowerCase().startsWith(r.name.toLowerCase())
    );
    if (driveMatch) {
      const remaining = normalized.substring(driveMatch.name.length);
      const cleanPath = remaining.replace(/^[/:]+/, '');
      return { remote: driveMatch, path: cleanPath };
    }

    // Rclone Syntax Match (remote:path)
    const colonIdx = normalized.indexOf(':');
    if (colonIdx > -1) {
      const rName = normalized.substring(0, colonIdx);
      const rPath = normalized.substring(colonIdx + 1);
      const remoteMatch = known.find(r => r.name === rName);
      const targetRemote: ExplorerRoot = remoteMatch ?? {
        name: rName,
        label: rName,
        type: 'cloud',
        isLocal: false,
      };
      const cleanPath = rPath.startsWith('/') ? rPath.substring(1) : rPath;
      return { remote: targetRemote, path: cleanPath };
    }

    // Unix Root
    if (normalized.startsWith('/')) {
      const root = known.find(r => r.name === '/');
      if (root) return { remote: root, path: normalized.substring(1) };
    }

    // Bare Remote Name Match (fallback)
    const exactRemoteMatch = known.find(r => r.name === normalized || r.name === rawInput);
    if (exactRemoteMatch) {
      return { remote: exactRemoteMatch, path: '' };
    }

    return null;
  }

  private isLocationAllowedByConfig(loc: string, cfg: FilePickerConfig): boolean {
    const hasColon = loc.includes(':');
    if (cfg.mode === 'local' && hasColon) return false;
    if (cfg.mode === 'remote') {
      if (!hasColon) return false;
      const remote = getRemoteNameFromFs(loc);
      if (cfg.allowedRemotes?.length) return cfg.allowedRemotes.includes(remote);
      return true;
    }
    // mode === 'both'
    if (hasColon && cfg.allowedRemotes?.length) {
      return cfg.allowedRemotes.includes(getRemoteNameFromFs(loc));
    }
    return true;
  }

  private isDataReadyForConfig(cfg: FilePickerConfig): boolean {
    const hasColon = !!cfg.initialLocation && cfg.initialLocation.includes(':');
    const localCount = this.localDrives().length;
    const remoteList = this.cloudRemotes();

    if (cfg.initialLocation) {
      if (hasColon) {
        if (remoteList.length === 0) return false;
        if (cfg.allowedRemotes?.length) {
          const r = getRemoteNameFromFs(cfg.initialLocation);
          return cfg.allowedRemotes.includes(r) && remoteList.some(x => x.name === r);
        }
        return true;
      }
      return localCount > 0;
    }

    if (cfg.mode === 'local') return localCount > 0;
    if (cfg.mode === 'remote') {
      if (remoteList.length === 0) return false;
      if (cfg.allowedRemotes?.length)
        return remoteList.some(x => cfg.allowedRemotes!.includes(x.name));
      return true;
    }
    return true;
  }

  private getItemsToProcess(draggedItem: FileBrowserItem): FileBrowserItem[] {
    const currentSelected = this.selectedItems();
    if (currentSelected.has(this.getItemKey(draggedItem))) {
      const allFiles = this.activePaneIndex() === 0 ? this.files() : this.filesRight();
      return allFiles.filter(item => currentSelected.has(this.getItemKey(item)));
    }
    return [draggedItem];
  }

  onDragStarted(event: DragEvent, item: FileBrowserItem): void {
    const items = this.getItemsToProcess(item);
    this.isDragging.set(true);
    this._lastDragHitKey = '';
    this._draggedItems = items;

    const payload: NautilusDragPayload = { items, sourcePaneIndex: this.activePaneIndex() };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData(NAUTILUS_DRAG_MIME_TYPE, JSON.stringify(payload));
    }
  }

  onDragEnded(): void {
    this.isDragging.set(false);
    this._dragCounter = 0;
    this._lastDragHitKey = '';
    this._clearHoverOpenTimer();
    this._draggedItems = [];
    this.hoveredFolder.set(null);
    this.hoveredSegmentIndex.set(null);
    this.hoveredTabIndex.set(null);
  }

  onDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('application/x-nautilus-tab')) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this._onDragMove({ x: event.clientX, y: event.clientY });
  }

  onContainerDragEnter(_event: DragEvent): void {
    this._dragCounter++;
    if (this._dragCounter === 1) {
      if (!this.isDragging()) {
        this.isDragging.set(true);
      }
    }
  }

  onContainerDragLeave(_event: DragEvent): void {
    this._dragCounter--;
    if (this._dragCounter <= 0) {
      this._dragCounter = 0;
      if (this._draggedItems.length === 0) {
        this.onDragEnded();
      }
    }
  }

  onContainerDrop(event: DragEvent): void {
    event.preventDefault();

    const activeRemote = this.activeRemote();
    if (activeRemote && this.hasExternalDropFiles(event)) {
      void this.processExternalDrop(event, { remote: activeRemote, path: this.activePath() });
    }

    this._dragCounter = 0;
    if (this._draggedItems.length === 0) {
      this.onDragEnded();
    }
  }

  private async processDrop(
    event: DragEvent,
    target: { remote: ExplorerRoot | null; path: string }
  ): Promise<void> {
    event.preventDefault();

    if (target.remote && this.hasExternalDropFiles(event)) {
      await this.processExternalDrop(event, target);
      return;
    }

    const data = event.dataTransfer?.getData(NAUTILUS_DRAG_MIME_TYPE);
    if (!data || !target.remote) return;

    const payload: NautilusDragPayload = JSON.parse(data);
    const items = payload.items;
    if (!items.length) return;

    // Prevent dropping a folder onto itself.
    if (items.some(item => item.entry.IsDir && item.entry.Path === target.path)) return;

    // Prevent dropping into the same directory.
    const sourceParentPath = items[0].entry.Path.substring(
      0,
      items[0].entry.Path.lastIndexOf(items[0].entry.Name)
    ).replace(/\/$/, '');
    const normalizedTarget = target.path.replace(/\/$/, '');
    const sourceRemote = items[0].meta.remote ?? '';
    const isSameRemote =
      this.pathSelectionService.normalizeRemoteName(sourceRemote) ===
      this.pathSelectionService.normalizeRemoteName(target.remote.name);

    if (isSameRemote && sourceParentPath === normalizedTarget) return;

    await this.performFileOperations(
      items,
      target.remote,
      target.path,
      isSameRemote ? 'move' : 'copy'
    );
  }

  private hasExternalDropFiles(event: DragEvent): boolean {
    const dt = event.dataTransfer;
    if (!dt) return false;

    if (dt.files.length > 0) return true;

    return Array.from(dt.items).some(item => item.kind === 'file');
  }

  private async setupDesktopNativeDropListener(): Promise<void> {
    if (!isTauriRuntime()) return;

    try {
      this.desktopDropUnlisten = await getCurrentWindow().onDragDropEvent(async event => {
        if (event.payload.type !== 'drop') return;

        const target = this.resolveDropTargetFromPoint(
          event.payload.position.x,
          event.payload.position.y
        );
        if (!target.remote || event.payload.paths.length === 0) return;

        const normalizedRemote = this.getNormalizedRemoteName(target.remote);
        const result = await this.remoteOps.uploadLocalDropPaths(
          normalizedRemote,
          target.path,
          event.payload.paths,
          'nautilus'
        );

        if (result.uploaded > 0) {
          this.refresh();
          this.notificationService.showSuccess(`Uploaded ${result.uploaded} file(s).`);
        }

        if (result.failed.length > 0) {
          this.notificationService.showError(
            `Failed to upload ${result.failed.length} dropped path(s).`
          );
        }
      });
    } catch (error) {
      console.warn('Desktop drag-drop listener setup failed', error);
    }
  }

  private resolveDropTargetFromPoint(
    x: number,
    y: number
  ): { remote: ExplorerRoot | null; path: string } {
    const resolved = this._resolveDropHit({ x, y });
    const folder = resolved.folder ?? this.hoveredFolder();
    const segIdx = resolved.segmentIndex ?? this.hoveredSegmentIndex();
    const tabIdx = resolved.tabIndex ?? this.hoveredTabIndex();

    if (tabIdx !== null) {
      const tab = this.tabs()[tabIdx];
      if (tab?.left.remote) {
        return { remote: tab.left.remote, path: tab.left.path };
      }
    }

    const paneIndex = (resolved.paneIndex as 0 | 1 | null) ?? this.activePaneIndex();
    const paneRef = this.getPaneRef(paneIndex);
    const paneRemote = paneRef.remote();

    if (!paneRemote) return { remote: null, path: '' };

    if (folder?.entry.IsDir) {
      const folderRemote = this.allRemotesLookup().find(
        r =>
          this.pathSelectionService.normalizeRemoteName(r.name) ===
          this.pathSelectionService.normalizeRemoteName(folder.meta.remote)
      );
      return { remote: folderRemote ?? paneRemote, path: folder.entry.Path };
    }

    if (segIdx !== null) {
      return {
        remote: paneRemote,
        path: segIdx < 0 ? '' : (this.pathSegments()[segIdx]?.path ?? ''),
      };
    }

    return { remote: paneRemote, path: paneRef.path() };
  }

  private async processExternalDrop(
    event: DragEvent,
    target: { remote: ExplorerRoot | null; path: string }
  ): Promise<void> {
    if (!target.remote) return;

    const droppedFiles = await this.extractExternalDropFiles(event);
    if (!droppedFiles.length) return;

    const normalizedRemote = this.getNormalizedRemoteName(target.remote);
    const createdDirectories = new Set<string>();

    let uploadedCount = 0;
    const failedUploads: string[] = [];

    for (const droppedFile of droppedFiles) {
      try {
        const destination = this.joinRemotePath(target.path, droppedFile.relativePath);
        const { directory, filename } = this.splitDirectoryAndFilename(destination);

        if (directory && !createdDirectories.has(directory)) {
          await this.remoteOps.makeDirectory(normalizedRemote, directory, 'nautilus', true);
          createdDirectories.add(directory);
        }

        const bytes = new Uint8Array(await droppedFile.file.arrayBuffer());
        await this.remoteOps.uploadFileBytes(
          normalizedRemote,
          directory,
          filename,
          bytes,
          'nautilus'
        );
        uploadedCount += 1;
      } catch (error) {
        console.error('External drop upload failed', error);
        failedUploads.push(droppedFile.relativePath || droppedFile.file.name);
      }
    }

    if (uploadedCount > 0) {
      this.refresh();
      this.notificationService.showSuccess(`Uploaded ${uploadedCount} file(s).`);
    }

    if (failedUploads.length > 0) {
      this.notificationService.showError(
        `Failed to upload ${failedUploads.length} file(s): ${failedUploads.slice(0, 3).join(', ')}`
      );
    }
  }

  private async extractExternalDropFiles(event: DragEvent): Promise<ExternalDropFile[]> {
    const dt = event.dataTransfer;
    if (!dt) return [];

    const fromEntries = await this.extractExternalFilesFromEntries(dt.items);
    if (fromEntries.length > 0) {
      return fromEntries;
    }

    return Array.from(dt.files)
      .filter(file => file.size >= 0)
      .map(file => ({ file, relativePath: file.webkitRelativePath || file.name }));
  }

  private async extractExternalFilesFromEntries(
    items: DataTransferItemList
  ): Promise<ExternalDropFile[]> {
    const results: ExternalDropFile[] = [];

    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (!entry) continue;
      await this.collectEntryFiles(entry, '', results);
    }

    return results;
  }

  private async collectEntryFiles(
    entry: FileSystemEntry,
    prefix: string,
    results: ExternalDropFile[]
  ): Promise<void> {
    if (entry.isFile) {
      const file = await this.readFileEntry(entry as FileSystemFileEntry);
      const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
      results.push({ file, relativePath });
      return;
    }

    if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const children = await this.readDirectoryEntries(dirEntry);
      for (const child of children) {
        await this.collectEntryFiles(child, nextPrefix, results);
      }
    }
  }

  private readFileEntry(entry: FileSystemFileEntry): Promise<File> {
    return new Promise((resolve, reject) => {
      entry.file(resolve, reject);
    });
  }

  private readDirectoryEntries(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
    const reader = entry.createReader();
    const entries: FileSystemEntry[] = [];

    return new Promise((resolve, reject) => {
      const readBatch = (): void => {
        reader.readEntries(batch => {
          if (!batch.length) {
            resolve(entries);
            return;
          }
          entries.push(...batch);
          readBatch();
        }, reject);
      };

      readBatch();
    });
  }

  private joinRemotePath(basePath: string, relativePath: string): string {
    const cleanedBase = basePath.replace(/^\/+|\/+$/g, '');
    const cleanedRelative = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

    if (!cleanedBase) return cleanedRelative;
    if (!cleanedRelative) return cleanedBase;
    return `${cleanedBase}/${cleanedRelative}`;
  }

  private splitDirectoryAndFilename(path: string): { directory: string; filename: string } {
    const parts = path.split('/').filter(Boolean);
    const filename = parts.pop() ?? '';
    return {
      directory: parts.join('/'),
      filename,
    };
  }

  onDropToStarred(event: DragEvent): void {
    const data = event.dataTransfer?.getData(NAUTILUS_DRAG_MIME_TYPE);
    if (!data) return;
    const payload: NautilusDragPayload = JSON.parse(data);
    payload.items.forEach(item => !this.isStarred(item) && this.toggleStar(item));
  }

  onDropToLocal(event: DragEvent): void {
    const data = event.dataTransfer?.getData(NAUTILUS_DRAG_MIME_TYPE);
    if (!data) return;
    const payload: NautilusDragPayload = JSON.parse(data);
    payload.items.forEach(item => item.entry.IsDir && this.toggleBookmark(item));
  }

  async onDropToBookmark(event: DragEvent, bookmark: FileBrowserItem): Promise<void> {
    const targetRemote = this.allRemotesLookup().find(
      r =>
        this.pathSelectionService.normalizeRemoteName(r.name) ===
        this.pathSelectionService.normalizeRemoteName(bookmark.meta.remote)
    );
    await this.processDrop(event, { remote: targetRemote ?? null, path: bookmark.entry.Path });
  }

  async onDropToRemote(event: DragEvent, targetRemote: ExplorerRoot): Promise<void> {
    await this.processDrop(event, { remote: targetRemote, path: '' });
  }

  async onDropToFolder(event: DragEvent, targetFolder: FileBrowserItem): Promise<void> {
    const targetRemote = this.allRemotesLookup().find(
      r =>
        this.pathSelectionService.normalizeRemoteName(r.name) ===
        this.pathSelectionService.normalizeRemoteName(targetFolder.meta.remote)
    );
    await this.processDrop(event, { remote: targetRemote ?? null, path: targetFolder.entry.Path });
  }

  async onDropToCurrentDirectory(event: DragEvent, paneIndex: number): Promise<void> {
    const pIdx = paneIndex as 0 | 1;
    const targetRemote = this.getPaneRef(pIdx).remote();
    if (!targetRemote) return;

    const resolved = this._resolveDropHit({ x: event.clientX, y: event.clientY });
    const folder = resolved.folder ?? this.hoveredFolder();
    const segIdx = resolved.segmentIndex ?? this.hoveredSegmentIndex();
    const tabIdx = resolved.tabIndex ?? this.hoveredTabIndex();

    if (tabIdx !== null) {
      const tab = this.tabs()[tabIdx];
      if (tab?.left.remote) {
        await this.processDrop(event, { remote: tab.left.remote, path: tab.left.path });
      }
      return;
    }

    let targetPath: string;
    if (folder) {
      targetPath = folder.entry.Path;
    } else if (segIdx !== null) {
      targetPath = segIdx < 0 ? '' : (this.pathSegments()[segIdx]?.path ?? '');
    } else {
      targetPath = this.getPaneRef(pIdx).path();
    }

    await this.processDrop(event, { remote: targetRemote, path: targetPath });
  }

  async onDropToSegment(event: DragEvent, segIdx: number): Promise<void> {
    const pIdx = this.activePaneIndex();
    const targetRemote = this.getPaneRef(pIdx).remote();
    if (!targetRemote) return;

    const targetPath = segIdx < 0 ? '' : (this.pathSegments()[segIdx]?.path ?? '');
    const currentPath = this.getPaneRef(pIdx).path();
    if (targetPath === currentPath) return;

    await this.processDrop(event, { remote: targetRemote, path: targetPath });
  }

  toggleBookmark(item: FileBrowserItem): void {
    this.nautilusService.toggleItem('bookmarks', item);
  }

  openBookmark(bookmark: FileBrowserItem): void {
    const remoteDetails = this.allRemotesLookup().find(
      r =>
        this.pathSelectionService.normalizeRemoteName(r.name) ===
        this.pathSelectionService.normalizeRemoteName(bookmark.meta.remote)
    );
    if (!remoteDetails) {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.bookmarkRemoteNotFound', {
          remote: bookmark.meta.remote,
        })
      );
      return;
    }
    this.selectRemote(remoteDetails);
    this.updatePath(bookmark.entry.Path);
    if (this.isMobile()) this.sidenav.close();
  }

  selectRemote(remote: ExplorerRoot | null): void {
    if (!remote) return;
    this._navigate(remote, '', true);
  }

  updatePath(newPath: string): void {
    this._navigate(this.activeRemote(), newPath, true);
  }

  navigateToSegment(index: number): void {
    const seg = this.pathSegments()[index];
    if (seg) this.updatePath(seg.path);
  }

  navigateToPath(rawInput: string): void {
    this.isEditingPath.set(false);

    const parsed = this.parseLocationToRemoteAndPath(rawInput);
    if (parsed) {
      this._navigate(parsed.remote, parsed.path, true);
      return;
    }

    // Fallback: treat as relative path from current location.
    const normalized = rawInput.replace(/\\/g, '/');
    const currentPath = this.activePath();
    this.updatePath(currentPath ? `${currentPath}/${normalized}` : normalized);
  }

  protected navigateTo(item: FileBrowserItem, isNewTab = false): void {
    const idx = this.activeTabIndex();
    const tab = this.tabs()[idx];
    if (!tab) return;
    const pane = this.activePaneIndex() === 0 ? tab.left : tab.right;
    if (!pane) return;

    if (item.entry.IsDir) {
      if (!isNewTab) {
        this._navigate(pane.remote, item.entry.Path, true);
      } else {
        this.createTab(pane.remote, item.entry.Path);
      }
    } else {
      this.openFilePreview(item);
    }
  }

  private _navigate(remote: ExplorerRoot | null, path: string, newHistory: boolean): void {
    const index = this.activeTabIndex();
    const pIdx = this.activePaneIndex();
    const tab = this.tabs()[index];
    if (!tab) return;

    const pane = pIdx === 0 ? tab.left : tab.right;
    if (!pane) return;

    let updatedHistory = pane.history;
    let updatedHistoryIndex = pane.historyIndex;

    if (newHistory) {
      if (pane.historyIndex < pane.history.length - 1) {
        updatedHistory = pane.history.slice(0, pane.historyIndex + 1);
      }
      updatedHistory = [...updatedHistory, { remote, path }];
      updatedHistoryIndex = updatedHistory.length - 1;
    }

    const currentStarredMode = pIdx === 0 ? this.starredMode() : this.starredModeRight();
    const targetStarredMode = !remote && path === '';
    const computedTitle =
      targetStarredMode || (currentStarredMode && !remote)
        ? this.translate.instant('nautilus.titles.starred')
        : path.split('/').pop() || remote?.label || this.translate.instant('nautilus.titles.files');

    this.tabs.update(tabs =>
      tabs.map((t, i) => {
        if (i !== index) return t;
        const updatedPane: PaneState = {
          ...pane,
          remote,
          path,
          selection: new Set<string>(),
          history: updatedHistory,
          historyIndex: updatedHistoryIndex,
        };
        return pIdx === 0
          ? { ...t, left: updatedPane, title: computedTitle }
          : { ...t, right: updatedPane };
      })
    );

    const ref = this.getPaneRef(pIdx);
    ref.remote.set(remote);
    ref.path.set(path);
    ref.selection.set(new Set<string>());
  }

  private createPaneState(remote: ExplorerRoot | null, path = ''): PaneState {
    return {
      remote,
      path,
      selection: new Set<string>(),
      history: [{ remote, path }],
      historyIndex: 0,
      rawFiles: signal<FileBrowserItem[]>([]),
      isLoading: signal(false),
      error: signal<string | null>(null),
      refreshTrigger: signal(0),
    };
  }

  createTab(remote: ExplorerRoot | null, path = ''): void {
    const id = ++this.interfaceTabCounter;
    const title =
      path.split('/').pop() ||
      remote?.label ||
      this.translate.instant(!remote ? 'nautilus.titles.starred' : 'nautilus.titles.files');

    const paneState = this.createPaneState(remote, path);

    // For Ctrl+T / duplicate-location tab, preserve the active pane listing to avoid empty content.
    const activeRemote = this.activeRemote();
    const activePath = this.activePath();
    if (remote && activeRemote && remote.name === activeRemote.name && path === activePath) {
      const activeFiles = this.activePaneIndex() === 0 ? this.rawFiles() : this.rawFilesRight();
      const activeLoading = this.activePaneIndex() === 0 ? this.isLoading() : this.isLoadingRight();
      const activeError = this.activePaneIndex() === 0 ? this.errorState() : this.errorStateRight();

      paneState.rawFiles.set(activeFiles);
      paneState.isLoading.set(activeLoading);
      paneState.error.set(activeError);
    }

    const t: Tab = { id, title, left: paneState };
    this.tabs.update(list => [...list, t]);
    this.switchTab(this.tabs().length - 1);
  }

  closeTab(i: number): void {
    if (i < 0 || i >= this.tabs().length) return;
    this.tabs.update(list => list.filter((_, idx) => idx !== i));
    if (this.tabs().length === 0) {
      this.closeOverlay.emit();
      return;
    }
    const newIndex =
      i <= this.activeTabIndex() ? Math.max(0, this.activeTabIndex() - 1) : this.activeTabIndex();
    this.switchTab(newIndex);
  }

  switchTab(i: number): void {
    const list = this.tabs();
    if (i < 0 || i >= list.length) return;
    this.activeTabIndex.set(i);
    const t = list[i];
    this.syncPaneSignals(0, t.left);
    if (t.right) {
      this.syncPaneSignals(1, t.right);
    } else {
      this.activePaneIndex.set(0);
    }
  }

  protected toggleSplit(): void {
    const idx = this.activeTabIndex();
    const tab = this.tabs()[idx];
    if (!tab) return;

    // Use explicit property exclusion instead of delete on a cast type.
    this.tabs.update(list =>
      list.map((t, i) => {
        if (i !== idx) return t;
        if (t.right) {
          const rest = { ...t };
          delete (rest as Partial<Tab>).right;
          return rest as Tab;
        }
        return { ...t, right: this.createPaneState(t.left.remote, t.left.path) };
      })
    );

    const updatedTab = this.tabs()[idx];
    if (updatedTab.right) {
      this.syncPaneSignals(1, updatedTab.right);
    } else {
      this.activePaneIndex.set(0);
    }
  }

  private syncPaneSignals(paneIndex: 0 | 1, state: PaneState): void {
    const ref = this.getPaneRef(paneIndex);
    ref.remote.set(state.remote);
    ref.path.set(state.path);
    ref.selection.set(state.selection);
    ref.rawFiles.set(state.rawFiles());
    ref.loading.set(state.isLoading());
    ref.error.set(state.error());
  }

  protected switchPane(index: 0 | 1): void {
    if (!this.isSplitEnabled() && index === 1) return;
    this.activePaneIndex.set(index);
  }

  onSplitDividerDrag(event: MouseEvent): void {
    event.preventDefault();
    const container = (event.target as HTMLElement).parentElement;
    if (!container) return;

    const onMouseMove = (e: MouseEvent): void => {
      const rect = container.getBoundingClientRect();
      const pos = ((e.clientX - rect.left) / rect.width) * 100;
      this.splitDividerPos.set(Math.max(20, Math.min(80, pos)));
    };

    const onMouseUp = (): void => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      this.appSettingsService.saveSetting(
        'nautilus',
        'split_divider_pos',
        Math.round(this.splitDividerPos())
      );
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  protected closeOtherTabs(index: number): void {
    const list = this.tabs();
    if (index < 0 || index >= list.length) return;
    this.tabs.set([list[index]]);
    this.switchTab(0);
  }

  protected closeTabsToRight(index: number): void {
    const list = this.tabs();
    if (index < 0 || index >= list.length) return;
    this.tabs.set(list.slice(0, index + 1));
    if (this.activeTabIndex() > index) this.switchTab(index);
  }

  protected duplicateTab(index: number): void {
    const tab = this.tabs()[index];
    if (!tab) return;
    this.createTab(tab.left.remote, tab.left.path);
  }

  protected moveTab(previousIndex: number, currentIndex: number): void {
    this.tabs.update(list => {
      const newList = [...list];
      const [item] = newList.splice(previousIndex, 1);
      newList.splice(currentIndex, 0, item);
      return newList;
    });

    const activeIdx = this.activeTabIndex();
    if (activeIdx === previousIndex) {
      this.activeTabIndex.set(currentIndex);
    } else if (previousIndex < activeIdx && currentIndex >= activeIdx) {
      this.activeTabIndex.set(activeIdx - 1);
    } else if (previousIndex > activeIdx && currentIndex <= activeIdx) {
      this.activeTabIndex.set(activeIdx + 1);
    }
  }

  private traverseHistory(direction: 1 | -1): void {
    const idx = this.activeTabIndex();
    const tab = this.tabs()[idx];
    if (!tab) return;
    const pIdx = this.activePaneIndex();
    const pane = pIdx === 0 ? tab.left : tab.right;
    if (!pane) return;

    const newHistoryIndex = pane.historyIndex + direction;
    if (newHistoryIndex < 0 || newHistoryIndex >= pane.history.length) return;

    const entry = pane.history[newHistoryIndex];
    this.tabs.update(tabs =>
      tabs.map((t, i) => {
        if (i !== idx) return t;
        if (pIdx === 0) return { ...t, left: { ...t.left, historyIndex: newHistoryIndex } };
        return { ...t, right: t.right ? { ...t.right, historyIndex: newHistoryIndex } : undefined };
      })
    );
    this._navigate(entry.remote, entry.path, false);
  }

  goBack(): void {
    this.traverseHistory(-1);
  }

  goForward(): void {
    this.traverseHistory(1);
  }

  refresh(): void {
    this.getPaneRef(this.activePaneIndex()).refreshTrigger.update(v => v + 1);
  }

  onItemClick(item: FileBrowserItem, event: Event, index: number): void {
    event.stopPropagation();
    if (this.isPickerMode() && !this.isItemSelectable(item.entry)) return;

    const pIdx = this.activePaneIndex();
    const currentSel = pIdx === 0 ? this.selectedItems() : this.selectedItemsRight();
    const multi = !this.isPickerMode() || !!this.pickerOptions().multi;
    const e = event as MouseEvent;
    const itemKey = this.getItemKey(item);
    const newSel = new Set<string>();

    if (e.shiftKey && this.lastSelectedIndex !== null && multi) {
      const files = pIdx === 0 ? this.files() : this.filesRight();
      const start = Math.min(this.lastSelectedIndex, index);
      const end = Math.max(this.lastSelectedIndex, index);
      for (let i = start; i <= end; i++) newSel.add(this.getItemKey(files[i]));
    } else if (e.ctrlKey || e.metaKey) {
      currentSel.forEach(k => newSel.add(k));
      if (newSel.has(itemKey)) newSel.delete(itemKey);
      else newSel.add(itemKey);
      this.lastSelectedIndex = index;
    } else {
      newSel.add(itemKey);
      this.lastSelectedIndex = index;
    }

    this.syncSelection(newSel);
  }

  setContextItem(item: FileBrowserItem | null): void {
    this.contextMenuItem.set(item);

    if (item) {
      const pIdx = this.activePaneIndex();
      const currentSelection = pIdx === 0 ? this.selectedItems() : this.selectedItemsRight();
      if (!currentSelection.has(this.getItemKey(item))) {
        this.syncSelection(new Set<string>([this.getItemKey(item)]));
        this.lastSelectedIndex = (pIdx === 0 ? this.files() : this.filesRight()).findIndex(
          f => this.getItemKey(f) === this.getItemKey(item)
        );
      }
    }
  }

  openContextMenuOpen(): void {
    const item = this.contextMenuItem();
    if (item) this.navigateTo(item);
  }

  openContextMenuOpenInNewTab(): void {
    const item = this.contextMenuItem();
    if (!item?.entry.IsDir) return;

    let root = this.activeRemote();
    if (!root && item.meta.remote) {
      const remoteName = this.pathSelectionService.normalizeRemoteName(item.meta.remote);
      root =
        this.allRemotesLookup().find(
          r => this.pathSelectionService.normalizeRemoteName(r.name) === remoteName
        ) || null;
    }

    if (root) {
      this.createTab(root, item.entry.Path);
    } else {
      console.warn('Could not resolve ExplorerRoot for item', item);
      this.notificationService.showError(this.translate.instant('fileBrowser.resolveRemoteFailed'));
    }
  }

  openContextMenuOpenInNewWindow(): void {
    const item = this.contextMenuItem();
    if (!item?.entry.IsDir) return;
    this.nautilusService.newNautilusWindow(item.meta.remote, item.entry.Path);
  }

  openContextMenuCopyPath(): void {
    const item = this.contextMenuItem();
    const remote = this.activeRemote();
    if (!item || !remote) return;

    const cleanRemote = remote.isLocal
      ? remote.name
      : this.pathSelectionService.normalizeRemoteForRclone(remote.name) + ':';

    const full = `${cleanRemote}${item.entry.Path}`.replace('//', '/');
    navigator.clipboard?.writeText(full);
  }

  onSidebarRequestProperties(item: FileBrowserItem): void {
    this.openPropertiesDialog('contextMenu', item);
  }

  private getNormalizedRemoteName(remote: ExplorerRoot | null): string {
    if (!remote) return '';
    return remote.isLocal
      ? remote.name
      : this.pathSelectionService.normalizeRemoteForRclone(remote.name);
  }

  openPropertiesDialog(source: 'contextMenu' | 'bookmark', itemOverride?: FileBrowserItem): void {
    const activeRemote = this.activeRemote();
    const item = itemOverride || this.contextMenuItem();
    if (source === 'bookmark' && !item) return;

    const path = item?.entry.Path || this.activePath();
    const isLocal = item?.meta.isLocal ?? activeRemote?.isLocal ?? true;

    let remoteName = item?.meta.remote || activeRemote?.name;
    if (remoteName && !isLocal) {
      remoteName = this.pathSelectionService.normalizeRemoteForRclone(remoteName);
    }

    const baseName = this.pathSelectionService.normalizeRemoteName(
      item?.meta.remote || activeRemote?.name || ''
    );
    const features = this.remoteFacadeService.featuresSignal(baseName)() as RemoteFeatures;

    this.dialog.open(PropertiesModalComponent, {
      data: {
        remoteName,
        path,
        isLocal,
        item: item?.entry,
        remoteType: item?.meta.remoteType || activeRemote?.type,
        features,
      },
      height: '60vh',
      maxHeight: '800px',
      width: '60vw',
      maxWidth: '400px',
    });
  }

  async openContextMenuNewFolder(): Promise<void> {
    const remote = this.activeRemote();
    if (!remote) return;

    const normalized = this.getNormalizedRemoteName(remote);
    const ref = this.dialog.open(InputModalComponent, {
      data: {
        title: this.translate.instant('nautilus.modals.newFolder.title'),
        label: this.translate.instant('nautilus.modals.newFolder.label'),
        icon: 'folder',
        placeholder: this.translate.instant('nautilus.modals.newFolder.placeholder'),
        existingNames: this.activeFiles().map(f => f.entry.Name),
      },
      disableClose: true,
    });

    try {
      const folderName = await firstValueFrom(ref.afterClosed());
      if (!folderName) return;
      const current = this.activePath();
      const sep = remote.isLocal && (current === '' || current.endsWith('/')) ? '' : '/';
      const newPath = current ? `${current}${sep}${folderName}` : folderName;
      await this.remoteOps.makeDirectory(normalized, newPath, 'nautilus', true);
      this.refresh();
    } catch {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.createFolderFailed')
      );
    }
  }

  async openContextMenuRename(): Promise<void> {
    const item = this.contextMenuItem();
    const remote = this.activeRemote();
    if (!item || !remote) return;

    const normalizedRemote = this.getNormalizedRemoteName(remote);
    const ref = this.dialog.open(InputModalComponent, {
      data: {
        title: this.translate.instant('nautilus.modals.rename.title'),
        label: this.translate.instant('nautilus.modals.rename.label'),
        icon: 'pen',
        placeholder: this.translate.instant('nautilus.modals.rename.placeholder'),
        initialValue: item.entry.Name,
        createLabel: this.translate.instant('nautilus.modals.rename.confirm'),
        existingNames: this.activeFiles()
          .filter(f => f.entry.Name !== item.entry.Name)
          .map(f => f.entry.Name),
      },
      disableClose: true,
    });

    try {
      const newName = await firstValueFrom(ref.afterClosed());
      if (!newName || newName === item.entry.Name) return;

      const pathParts = item.entry.Path.split('/');
      pathParts[pathParts.length - 1] = newName;
      const newPath = pathParts.join('/');

      if (item.entry.IsDir) {
        await this.remoteOps.renameDir(normalizedRemote, item.entry.Path, newPath, 'nautilus');
      } else {
        await this.remoteOps.renameFile(normalizedRemote, item.entry.Path, newPath, 'nautilus');
      }

      this.notificationService.showSuccess(
        this.translate.instant('nautilus.notifications.renameStarted')
      );
      this.refresh();
    } catch {
      this.notificationService.showError(this.translate.instant('nautilus.errors.renameFailed'));
    }
  }

  onSidebarRequestAbout(remote: ExplorerRoot): void {
    const normalized = remote.isLocal
      ? remote.name
      : this.pathSelectionService.normalizeRemoteForRclone(remote.name);
    this.dialog.open(RemoteAboutModalComponent, {
      data: { remote: { displayName: remote.name, normalizedName: normalized, type: remote.type } },
      ...STANDARD_MODAL_SIZE,
    });
  }

  onSidebarSidenavAction(action: 'close' | 'toggle'): void {
    if (action === 'close') this.sidenav.close();
    else this.sidenav.toggle();
  }

  async onSidebarRequestCleanup(r: ExplorerRoot): Promise<void> {
    const confirmed = await this.notificationService.confirmModal(
      this.translate.instant('nautilus.modals.emptyTrash.title'),
      this.translate.instant('nautilus.modals.emptyTrash.message', { remote: r.name }),
      undefined,
      undefined,
      { icon: 'trash', iconColor: 'warn', iconClass: 'destructive', confirmButtonColor: 'warn' }
    );
    if (!confirmed) return;
    try {
      const normalized = r.isLocal
        ? r.name
        : this.pathSelectionService.normalizeRemoteForRclone(r.name);
      await this.remoteOps.cleanup(normalized, undefined, 'nautilus');
      this.notificationService.showInfo(
        this.translate.instant('nautilus.notifications.trashEmptied')
      );
    } catch (e) {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.emptyTrashFailed', { error: (e as Error).message })
      );
    }
  }

  openRemoteInNewTab(remote: ExplorerRoot): void {
    this.createTab(remote, '');
  }

  openRemoteInNewWindow(remote: ExplorerRoot): void {
    this.nautilusService.newNautilusWindow(remote.name, '');
  }

  openBookmarkInNewTab(bookmark: FileBrowserItem): void {
    const remoteDetails = this.allRemotesLookup().find(
      r =>
        this.pathSelectionService.normalizeRemoteName(r.name) ===
        this.pathSelectionService.normalizeRemoteName(bookmark.meta.remote)
    );
    if (!remoteDetails) {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.bookmarkRemoteNotFound', {
          remote: bookmark.meta.remote,
        })
      );
      return;
    }
    this.createTab(remoteDetails, bookmark.entry.Path);
  }

  openBookmarkInNewWindow(bookmark: FileBrowserItem): void {
    const remoteDetails = this.allRemotesLookup().find(
      r =>
        this.pathSelectionService.normalizeRemoteName(r.name) ===
        this.pathSelectionService.normalizeRemoteName(bookmark.meta.remote)
    );
    if (!remoteDetails) {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.bookmarkRemoteNotFound', {
          remote: bookmark.meta.remote,
        })
      );
      return;
    }
    this.nautilusService.newNautilusWindow(remoteDetails.name, bookmark.entry.Path);
  }

  protected openShortcutsModal(): void {
    this.dialog.open(KeyboardShortcutsModalComponent, {
      ...STANDARD_MODAL_SIZE,
      data: { nautilus: true },
    });
  }

  async deleteSelectedItems(): Promise<void> {
    const remote = this.activeRemote();
    if (!remote) return;

    const selection = this.selectedItems();
    const contextItem = this.contextMenuItem();
    let itemsToDelete = this.activeFiles().filter(f => selection.has(this.getItemKey(f)));

    if (contextItem && !selection.has(this.getItemKey(contextItem))) {
      itemsToDelete = [contextItem];
    }
    if (itemsToDelete.length === 0) return;

    const isMultiple = itemsToDelete.length > 1;
    const message = isMultiple
      ? this.translate.instant('nautilus.modals.delete.messageMultiple', {
          count: itemsToDelete.length,
        })
      : this.translate.instant('nautilus.modals.delete.messageSingle', {
          name: itemsToDelete[0].entry.Name,
        });

    const confirmed = await this.notificationService.confirmModal(
      this.translate.instant('nautilus.modals.delete.title'),
      message,
      undefined,
      undefined,
      { icon: 'trash', iconColor: 'warn' }
    );
    if (!confirmed) return;

    const normalizedRemote = this.getNormalizedRemoteName(remote);
    let failCount = 0;

    this.notificationService.showInfo(
      this.translate.instant('nautilus.notifications.deleteStarted', {
        count: itemsToDelete.length,
      })
    );

    for (const item of itemsToDelete) {
      try {
        if (item.entry.IsDir) {
          await this.remoteOps.purgeDirectory(normalizedRemote, item.entry.Path, 'nautilus');
        } else {
          await this.remoteOps.deleteFile(normalizedRemote, item.entry.Path, 'nautilus');
        }
      } catch (e) {
        console.error('Delete failed for', item.entry.Path, e);
        failCount++;
      }
    }

    this.clearSelection();
    if (failCount > 0) {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.deleteFailed', {
          count: failCount,
          total: itemsToDelete.length,
        })
      );
    }
    this.refresh();
  }

  private prepareClipboardItems(mode: 'copy' | 'cut'): void {
    const selected = this.getSelectedItemsList();
    if (selected.length === 0) return;
    this.clipboardItems.set(
      selected.map(item => ({
        remote: item.meta.remote,
        path: item.entry.Path,
        name: item.entry.Name,
        isDir: item.entry.IsDir,
      }))
    );
    this.clipboardMode.set(mode);
  }

  protected copyItems(): void {
    this.prepareClipboardItems('copy');
  }

  protected cutItems(): void {
    this.prepareClipboardItems('cut');
  }

  protected async pasteItems(): Promise<void> {
    const clipboardData = this.clipboardItems();
    const mode = this.clipboardMode();
    const dstRemote = this.activeRemote();
    const dstPath = this.activePath();
    if (clipboardData.length === 0 || !dstRemote || !mode) return;

    const items: FileBrowserItem[] = clipboardData.map(item => {
      const remoteInfo = this.allRemotesLookup().find(r => r.name === item.remote);
      return {
        entry: {
          Name: item.name,
          Path: item.path,
          IsDir: item.isDir,
          ID: '',
          Size: 0,
          ModTime: '',
          MimeType: '',
        },
        meta: {
          remote: item.remote,
          isLocal: remoteInfo?.isLocal ?? false,
          remoteType: remoteInfo?.type,
        },
      };
    });

    await this.performFileOperations(items, dstRemote, dstPath, mode === 'cut' ? 'move' : 'copy');
    if (mode === 'cut') this.clearClipboard();
  }

  private async dispatchFileOp(
    mode: 'copy' | 'move',
    srcRemote: string,
    srcPath: string,
    dstRemote: string,
    dstPath: string,
    isDir: boolean
  ): Promise<void> {
    if (mode === 'copy') {
      if (isDir)
        await this.remoteOps.copyDirectory(srcRemote, srcPath, dstRemote, dstPath, 'nautilus');
      else await this.remoteOps.copyFile(srcRemote, srcPath, dstRemote, dstPath, 'nautilus');
    } else {
      if (isDir)
        await this.remoteOps.moveDirectory(srcRemote, srcPath, dstRemote, dstPath, 'nautilus');
      else await this.remoteOps.moveFile(srcRemote, srcPath, dstRemote, dstPath, 'nautilus');
    }
  }

  private async performFileOperations(
    items: FileBrowserItem[],
    dstRemote: ExplorerRoot,
    dstPath: string,
    mode: 'copy' | 'move'
  ): Promise<void> {
    if (items.length === 0) return;

    const normalizedDstRemote = this.pathSelectionService.normalizeRemoteForRclone(dstRemote.name);
    let failCount = 0;
    const succeededItems: UndoEntry['items'] = [];

    this.notificationService.showInfo(
      this.translate.instant(
        mode === 'copy'
          ? 'nautilus.notifications.copyStarted'
          : 'nautilus.notifications.moveStarted',
        { count: items.length }
      )
    );

    for (const item of items) {
      try {
        const sourceRemoteName = item.meta.remote || this.activeRemote()?.name || '';
        const normalizedSrcRemote =
          this.pathSelectionService.normalizeRemoteForRclone(sourceRemoteName);
        const destinationFile = dstPath ? `${dstPath}/${item.entry.Name}` : item.entry.Name;
        const isDir = !!item.entry.IsDir;

        await this.dispatchFileOp(
          mode,
          normalizedSrcRemote,
          item.entry.Path,
          normalizedDstRemote,
          destinationFile,
          isDir
        );

        succeededItems.push({
          srcRemote: normalizedSrcRemote,
          srcPath: item.entry.Path,
          dstRemote: normalizedDstRemote,
          dstFullPath: destinationFile,
          isDir,
          name: item.entry.Name,
        });
      } catch (e) {
        console.error(`${mode} failed for ${item.entry.Path}`, e);
        failCount++;
      }
    }

    if (succeededItems.length > 0) {
      const limit = NautilusComponent.MAX_UNDO_STACK;
      this._undoStack.update(s => [...s.slice(-(limit - 1)), { mode, items: succeededItems }]);
      this._redoStack.set([]);
    }

    this.refresh();

    if (failCount > 0) {
      this.notificationService.showError(
        this.translate.instant(
          mode === 'copy' ? 'nautilus.errors.copyFailed' : 'nautilus.errors.moveFailed',
          { count: failCount }
        )
      );
    } else {
      this.notificationService.showSuccess(
        this.translate.instant('nautilus.notifications.pasteStarted')
      );
    }
  }

  async undoLastOperation(): Promise<void> {
    const stack = this._undoStack();
    if (stack.length === 0) return;

    const entry = stack[stack.length - 1];
    this._undoStack.set(stack.slice(0, -1));

    let failCount = 0;
    for (const item of entry.items) {
      try {
        if (entry.mode === 'copy') {
          if (item.isDir) {
            await this.remoteOps.purgeDirectory(item.dstRemote, item.dstFullPath, 'nautilus');
          } else {
            await this.remoteOps.deleteFile(item.dstRemote, item.dstFullPath, 'nautilus');
          }
        } else {
          await this.dispatchFileOp(
            'move',
            item.dstRemote,
            item.dstFullPath,
            item.srcRemote,
            item.srcPath,
            item.isDir
          );
        }
      } catch (e) {
        console.error('undo failed for', item.dstFullPath, e);
        failCount++;
      }
    }

    this._redoStack.update(s => [...s.slice(-(NautilusComponent.MAX_UNDO_STACK - 1)), entry]);
    this.refresh();

    if (failCount > 0) {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.undoFailed', { count: failCount })
      );
    } else {
      this.notificationService.showSuccess(
        this.translate.instant('nautilus.notifications.undoComplete')
      );
    }
  }

  async redoLastOperation(): Promise<void> {
    const stack = this._redoStack();
    if (stack.length === 0) return;

    const entry = stack[stack.length - 1];
    this._redoStack.set(stack.slice(0, -1));

    let failCount = 0;
    for (const item of entry.items) {
      try {
        await this.dispatchFileOp(
          entry.mode,
          item.srcRemote,
          item.srcPath,
          item.dstRemote,
          item.dstFullPath,
          item.isDir
        );
      } catch (e) {
        console.error('redo failed for', item.srcPath, e);
        failCount++;
      }
    }

    this._undoStack.update(s => [...s.slice(-(NautilusComponent.MAX_UNDO_STACK - 1)), entry]);
    this.refresh();

    if (failCount > 0) {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.redoFailed', { count: failCount })
      );
    } else {
      this.notificationService.showSuccess(
        this.translate.instant('nautilus.notifications.redoComplete')
      );
    }
  }

  protected onUpdateSelection(selection: Set<string>, paneIndex: 0 | 1): void {
    const ref = this.getPaneRef(paneIndex);
    ref.selection.set(selection);
  }

  protected clearClipboard(): void {
    this.clipboardItems.set([]);
    this.clipboardMode.set(null);
  }

  private getSelectedItemsList(): FileBrowserItem[] {
    const selection = this.selectedItems();
    return this.activeFiles().filter(item => selection.has(this.getItemKey(item)));
  }

  async removeEmptyDirs(): Promise<void> {
    const remote = this.activeRemote();
    if (!remote) return;

    const selection = this.selectedItems();
    const item =
      this.contextMenuItem() ||
      this.activeFiles().find(f => selection.has(this.getItemKey(f)) && f.entry.IsDir);
    if (!item?.entry.IsDir) return;

    const confirmed = await this.notificationService.confirmModal(
      this.translate.instant('nautilus.modals.rmdirs.title'),
      this.translate.instant('nautilus.modals.rmdirs.message', { name: item.entry.Name }),
      this.translate.instant('nautilus.modals.rmdirs.confirm'),
      undefined,
      { icon: 'broom', iconColor: 'accent' }
    );
    if (!confirmed) return;

    const normalizedRemote = this.pathSelectionService.normalizeRemoteForRclone(remote.name);
    try {
      await this.remoteOps.removeEmptyDirs(normalizedRemote, item.entry.Path, 'nautilus');
      this.notificationService.showInfo(
        this.translate.instant('nautilus.notifications.rmdirsStarted', { name: item.entry.Name })
      );
    } catch (e) {
      console.error('Remove empty dirs failed for', item.entry.Path, e);
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.rmdirsFailed', {
          name: item.entry.Name,
          error: (e as Error).message,
        })
      );
    }

    this.refresh();
  }

  formatRelativeDate(dateString: string): string {
    if (!dateString) return '';
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  protected getItemKey = (item: FileBrowserItem | null): string => {
    if (!item) return '';
    return `${item.meta.remote}:${item.entry.Path}`;
  };

  async openFilePreview(item: FileBrowserItem): Promise<void> {
    const currentRemote = this.nautilusRemote();
    const actualRemoteName = item.meta.remote || currentRemote?.name;
    if (!actualRemoteName) {
      this.notificationService.showError(this.translate.instant('nautilus.errors.openFileFailed'));
      return;
    }

    const baseName = this.pathSelectionService.normalizeRemoteName(actualRemoteName);
    const features = this.remoteFacadeService.featuresSignal(baseName)() as RemoteFeatures;
    const isLocal =
      features?.isLocal ??
      item.meta.isLocal ??
      currentRemote?.isLocal ??
      isLocalPath(actualRemoteName);

    const currentFiles = this.files();
    const idx = currentFiles.findIndex(f => f.entry.Path === item.entry.Path);
    this.fileViewerService.open(
      currentFiles.map(f => f.entry),
      idx,
      actualRemoteName,
      isLocal
    );
  }

  confirmSelection(): void {
    let items = this.getSelectedItemsList();
    const remote = this.activeRemote();
    const currentPath = this.activePath();

    if (items.length === 0 && this.pickerOptions().selection === 'folders' && remote) {
      const name = currentPath.split('/').pop() || remote.name;
      items = [
        {
          entry: {
            Name: name,
            Path: currentPath,
            IsDir: true,
            Size: -1,
            ModTime: new Date().toISOString(),
            ID: '',
            MimeType: 'inode/directory',
          },
          meta: { remote: remote.name, isLocal: remote.isLocal, remoteType: remote.type },
        },
      ];
    }

    const minSel = this.pickerOptions().minSelection ?? 0;
    if (this.isPickerMode() && items.length < minSel) {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.minSelection', {
          min: minSel,
          s: minSel > 1 ? 's' : '',
        })
      );
      return;
    }

    this.nautilusService.closeFilePicker(items);
  }

  toggleStar(item: FileBrowserItem): void {
    this.nautilusService.toggleItem('starred', item);
  }

  isStarred(item: FileBrowserItem): boolean {
    const remote = item.meta.remote || this.nautilusRemote()?.name;
    if (!remote) return false;
    return this.nautilusService.isSaved('starred', remote, item.entry.Path);
  }

  private syncSelection(newSelection: Set<string>): void {
    const pIdx = this.activePaneIndex();
    this.getPaneRef(pIdx).selection.set(newSelection);

    this.tabs.update(tabs =>
      tabs.map((tab, i) => {
        if (i !== this.activeTabIndex()) return tab;
        if (pIdx === 0) return { ...tab, left: { ...tab.left, selection: newSelection } };
        return {
          ...tab,
          right: tab.right ? { ...tab.right, selection: newSelection } : undefined,
        };
      })
    );
  }

  isItemSelectable = (item: Entry): boolean => {
    if (!this.isPickerMode()) return true;
    const opts = this.pickerOptions();
    if (opts.selection === 'folders' && !item.IsDir) return false;
    if (opts.selection === 'files' && item.IsDir) return false;
    if (!item.IsDir && opts.allowedExtensions?.length) {
      const name = item.Name.toLowerCase();
      if (!opts.allowedExtensions.some((ext: string) => name.endsWith(ext.toLowerCase()))) {
        return false;
      }
    }
    return true;
  };

  increaseIconSize(): void {
    this.changeIconSize(1);
  }

  decreaseIconSize(): void {
    this.changeIconSize(-1);
  }

  private changeIconSize(direction: 1 | -1): void {
    const sizes = this.currentIconSizes();
    const cur = this.iconSize();
    let idx = sizes.indexOf(cur);
    if (idx === -1) {
      idx = sizes.findIndex(s => s > cur);
      if (idx === -1) idx = sizes.length - 1;
    }
    this.iconSize.set(sizes[Math.max(0, Math.min(sizes.length - 1, idx + direction))]);
    this.saveIconSize();
  }

  protected readonly increaseIconDisabled = computed(
    () => this.iconSize() >= this.currentIconSizes().at(-1)!
  );
  protected readonly decreaseIconDisabled = computed(
    () => this.iconSize() <= this.currentIconSizes()[0]
  );

  private saveIconSize(): void {
    const isGrid = this.layout() === 'grid';
    const key = isGrid ? 'grid_icon_size' : 'list_icon_size';
    const newSize = this.iconSize();
    if (isGrid) this.savedGridIconSize.set(newSize);
    else this.savedListIconSize.set(newSize);
    this.appSettingsService.saveSetting('nautilus', key, newSize);
  }

  setLayout(l: 'grid' | 'list'): void {
    this.saveIconSize();
    this.layout.set(l);
    this.appSettingsService.saveSetting('nautilus', 'default_layout', l);

    const savedSize = l === 'grid' ? this.savedGridIconSize() : this.savedListIconSize();
    if (savedSize) {
      this.iconSize.set(savedSize);
    } else {
      const sizes = l === 'grid' ? this.GRID_ICON_SIZES : this.LIST_ICON_SIZES;
      this.iconSize.set(sizes[Math.floor(sizes.length / 2)]);
    }
  }

  /** Applies a sort from an encoded string key (e.g. 'name-asc') without persisting. */
  private _applySort(key: string): void {
    const [col, dir] = key.split('-');
    this._sortColumn.set(col as 'name' | 'size' | 'modified');
    this._sortAscending.set(dir !== 'desc');
  }

  setSort(k: string): void {
    this._applySort(k);
    this.appSettingsService.saveSetting('nautilus', 'sort_key', k);
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
    this.appSettingsService.saveSetting('nautilus', 'sort_key', this.sortKey());
  }

  toggleShowHidden(v: boolean): void {
    this.showHidden.set(v);
    this.appSettingsService.saveSetting('nautilus', 'show_hidden_items', v);
  }

  selectStarred(): void {
    if (this.activeStarredMode()) return;
    this._navigate(null, '', true);
  }

  clearSelection(): void {
    this.syncSelection(new Set());
  }

  cancelLoad(paneIndex: 0 | 1 = 0): void {
    // Cancels the UI loading state. The in-flight request will still complete
    // but its result will be discarded once overwritten by the next load.
    this.getPaneRef(paneIndex).loading.set(false);
  }

  selectAll(): void {
    this.syncSelection(new Set(this.files().map(f => this.getItemKey(f))));
  }

  copyCurrentLocation(): void {
    const path = this.fullPathInput();
    if (path) {
      navigator.clipboard?.writeText(path);
      this.notificationService.showInfo(
        this.translate.instant('nautilus.notifications.locationCopied')
      );
    }
  }

  toggleSearchMode(): void {
    this.isSearchMode.update(v => !v);
    this.searchFilter.set('');
  }

  private subscribeToSettings(): void {
    combineLatest([
      this.appSettingsService.selectSetting('nautilus.default_layout'),
      this.appSettingsService.selectSetting('nautilus.sort_key'),
      this.appSettingsService.selectSetting('nautilus.show_hidden_items'),
      this.appSettingsService.selectSetting('nautilus.grid_icon_size'),
      this.appSettingsService.selectSetting('nautilus.list_icon_size'),
      this.appSettingsService.selectSetting('nautilus.split_divider_pos'),
    ])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([layout, sortKey, showHidden, gridIconSize, listIconSize, splitDividerPos]) => {
        if (layout?.value) this.layout.set(layout.value);
        if (sortKey?.value) this._applySort(sortKey.value);
        if (showHidden?.value !== undefined) this.showHidden.set(showHidden.value);
        if (gridIconSize?.value) this.savedGridIconSize.set(gridIconSize.value);
        if (listIconSize?.value) this.savedListIconSize.set(listIconSize.value);
        if (splitDividerPos?.value !== undefined) this.splitDividerPos.set(splitDividerPos.value);

        // Restore icon size for the current layout.
        const currentLayout = layout?.value ?? this.layout();
        const savedSize =
          currentLayout === 'grid' ? this.savedGridIconSize() : this.savedListIconSize();
        const sizes = currentLayout === 'grid' ? this.GRID_ICON_SIZES : this.LIST_ICON_SIZES;
        this.iconSize.set(savedSize ?? sizes[Math.floor(sizes.length / 2)]);
      });
  }

  @HostListener('window:keydown', ['$event'])
  public async handleKeyDown(event: KeyboardEvent): Promise<void> {
    if (this.dialog.openDialogs.length > 0) {
      return;
    }

    if (this.isInputFocused(event)) {
      if (event.key === 'Escape') (event.target as HTMLElement).blur();
      return;
    }

    const isCtrl = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;
    const isAlt = event.altKey;

    if (await this.handleClipboardShortcuts(event, isCtrl, isShift)) return;
    if (this.handleNavigationShortcuts(event, isCtrl, isAlt, isShift)) return;
    if (this.handleSelectionShortcuts(event, isCtrl)) return;
    if (await this.handleFileOperationsShortcuts(event, isCtrl, isShift)) return;
  }

  private isInputFocused(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement;
    return (
      target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
    );
  }

  private async handleClipboardShortcuts(
    event: KeyboardEvent,
    isCtrl: boolean,
    isShift: boolean
  ): Promise<boolean> {
    if (!isCtrl) return false;
    switch (event.key.toLowerCase()) {
      case 'c':
        event.preventDefault();
        this.copyItems();
        return true;
      case 'x':
        event.preventDefault();
        this.cutItems();
        return true;
      case 'v':
        event.preventDefault();
        await this.pasteItems();
        return true;
      case 'z':
        event.preventDefault();
        if (isShift) await this.redoLastOperation();
        else await this.undoLastOperation();
        return true;
      case 'y':
        event.preventDefault();
        await this.redoLastOperation();
        return true;
    }
    return false;
  }

  private handleNavigationShortcuts(
    event: KeyboardEvent,
    isCtrl: boolean,
    isAlt: boolean,
    isShift: boolean
  ): boolean {
    if (isCtrl && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      this.isEditingPath.set(true);
      return true;
    }

    if (event.key === 'Backspace' || (isAlt && event.key === 'ArrowUp')) {
      if (this.pathSegments().length > 0) {
        event.preventDefault();
        this.navigateToSegment(this.pathSegments().length - 2);
      }
      return true;
    }

    if (isAlt && event.key === 'ArrowLeft' && this.canGoBack()) {
      event.preventDefault();
      this.goBack();
      return true;
    }

    if (isAlt && event.key === 'ArrowRight' && this.canGoForward()) {
      event.preventDefault();
      this.goForward();
      return true;
    }

    if (event.key === 'Enter' && !isAlt) {
      const selected = this.getSelectedItemsList();
      if (selected.length === 1) {
        event.preventDefault();
        const item = selected[0];

        if (isCtrl) {
          this.setContextItem(item);
          this.openContextMenuOpenInNewTab();
        } else if (isShift) {
          this.setContextItem(item);
          this.openContextMenuOpenInNewWindow();
        } else {
          this.navigateTo(item);
        }
        return true;
      }
    }

    if (isCtrl && event.key === 'Tab') {
      event.preventDefault();
      const count = this.tabs().length;
      if (count > 0) {
        const next = isShift
          ? (this.activeTabIndex() - 1 + count) % count
          : (this.activeTabIndex() + 1) % count;
        this.switchTab(next);
      }
      return true;
    }

    if (isCtrl && event.key.toLowerCase() === 't') {
      event.preventDefault();
      if (isShift) this.duplicateTab(this.activeTabIndex());
      else this.createTab(this.activeRemote(), this.activePath());
      return true;
    }

    if (isCtrl && event.key.toLowerCase() === 'w') {
      event.preventDefault();
      this.closeTab(this.activeTabIndex());
      return true;
    }

    return false;
  }

  private handleSelectionShortcuts(event: KeyboardEvent, isCtrl: boolean): boolean {
    if (isCtrl && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.selectAll();
      return true;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.isPickerMode()) {
        this.nautilusService.closeFilePicker(null);
        return true;
      }
      if (this.selectedItems().size > 0) this.clearSelection();
      else this.clearClipboard();
      return true;
    }

    return false;
  }

  private async handleFileOperationsShortcuts(
    event: KeyboardEvent,
    isCtrl: boolean,
    isShift: boolean
  ): Promise<boolean> {
    if (event.key === 'F2') {
      const selected = this.getSelectedItemsList();
      if (selected.length === 1) {
        event.preventDefault();
        this.setContextItem(selected[0]);
        await this.openContextMenuRename();
        return true;
      }
    }

    if (event.key === 'Delete') {
      event.preventDefault();
      await this.deleteSelectedItems();
      return true;
    }

    if (event.key === 'F5' || (isCtrl && event.key.toLowerCase() === 'r')) {
      event.preventDefault();
      this.refresh();
      return true;
    }

    if (isCtrl && isShift && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      await this.openContextMenuNewFolder();
      return true;
    }

    if (event.altKey && event.key === 'Enter') {
      event.preventDefault();
      this.openPropertiesDialog('contextMenu');
      return true;
    }

    if (isCtrl && event.key === '/') {
      event.preventDefault();
      this.toggleSplit();
      return true;
    }

    if (isCtrl && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      this.toggleSearchMode();
      return true;
    }

    if (isCtrl && event.key.toLowerCase() === 'h') {
      event.preventDefault();
      this.toggleShowHidden(!this.showHidden());
      return true;
    }

    return false;
  }

  private _onDragMove(point: { x: number; y: number }): void {
    const hit = this._resolveDropHit(point);
    const hitKey = `${hit.folder?.entry.Path ?? 'null'}:${hit.segmentIndex ?? 'null'}:${hit.tabIndex ?? 'null'}:${hit.sidebarItem ?? 'null'}`;
    if (hitKey === this._lastDragHitKey) return;
    this._lastDragHitKey = hitKey;

    this.hoveredFolder.set(hit.folder);
    this.hoveredSegmentIndex.set(hit.segmentIndex);
    this.hoveredTabIndex.set(hit.tabIndex);
    this.hoveredSidebarItem.set(hit.sidebarItem);

    if (
      hit.paneIndex !== null &&
      this.isSplitEnabled() &&
      hit.paneIndex !== this.activePaneIndex()
    ) {
      this.switchPane(hit.paneIndex as 0 | 1);
    }

    this._scheduleHoverOpen(hitKey, hit);
  }

  private _clearHoverOpenTimer(): void {
    if (this._hoverOpenTimer !== null) {
      clearTimeout(this._hoverOpenTimer);
      this._hoverOpenTimer = null;
    }
    this._hoverOpenKey = '';
  }

  private _scheduleHoverOpen(
    hitKey: string,
    hit: {
      folder: FileBrowserItem | null;
      segmentIndex: number | null;
      tabIndex: number | null;
      sidebarItem: string | null;
    }
  ): void {
    if (hitKey === this._hoverOpenKey) return;
    this._clearHoverOpenTimer();

    if (!hit.folder && hit.segmentIndex === null && hit.tabIndex === null && !hit.sidebarItem)
      return;

    this._hoverOpenKey = hitKey;
    this._hoverOpenTimer = setTimeout(() => {
      this._hoverOpenTimer = null;
      if (!this.isDragging()) return;

      if (hit.folder?.entry.IsDir) {
        if (!this._draggedItems.some(item => item.entry.Path === hit.folder!.entry.Path)) {
          this.navigateTo(hit.folder);
        }
        return;
      }

      if (hit.segmentIndex !== null) {
        if (hit.segmentIndex < 0) this.updatePath('');
        else this.navigateToSegment(hit.segmentIndex);
        return;
      }

      if (hit.tabIndex !== null) {
        this.switchTab(hit.tabIndex);
        return;
      }

      if (hit.sidebarItem) {
        if (hit.sidebarItem === 'starred') {
          this.selectStarred();
        } else if (hit.sidebarItem.startsWith('bookmark:')) {
          const bmPath = hit.sidebarItem.replace('bookmark:', '');
          const bm = this.bookmarks().find(b => b.entry.Path === bmPath);
          if (bm) this.openBookmark(bm);
        } else if (hit.sidebarItem.startsWith('remote:')) {
          const remoteName = hit.sidebarItem.replace('remote:', '');
          const remote = this.allRemotesLookup().find(r => r.name === remoteName);
          if (remote) this.selectRemote(remote);
        }
      }
    }, NautilusComponent.HOVER_OPEN_DELAY_MS);
  }

  private _resolveDropHit(point: { x: number; y: number }): {
    folder: FileBrowserItem | null;
    segmentIndex: number | null;
    tabIndex: number | null;
    sidebarItem: string | null;
    paneIndex: number | null;
  } {
    const el = document.elementFromPoint(point.x, point.y);
    if (!el)
      return {
        folder: null,
        segmentIndex: null,
        tabIndex: null,
        sidebarItem: null,
        paneIndex: null,
      };

    const folderTarget = el.closest('[data-folder-path]');
    const segmentTarget = el.closest('[data-segment-index]');
    const tabTarget = el.closest('[data-tab-index]');
    const sidebarStarred = el.closest('[data-sidebar-starred]');
    const sidebarBookmarksHeader = el.closest('[data-sidebar-bookmarks-header]');
    const sidebarBookmark = el.closest('[data-sidebar-bookmark-path]');
    const sidebarRemote = el.closest('[data-sidebar-remote-name]');
    const paneTarget = el.closest('[data-pane-index]');

    const currentFiles = this.activePaneIndex() === 0 ? this.files() : this.filesRight();

    const folder = folderTarget
      ? (currentFiles.find(f => f.entry.Path === folderTarget.getAttribute('data-folder-path')) ??
        null)
      : null;

    let sidebarItem: string | null = null;
    if (sidebarStarred) sidebarItem = 'starred';
    else if (sidebarBookmarksHeader) sidebarItem = 'bookmarks-header';
    else if (sidebarBookmark)
      sidebarItem = 'bookmark:' + sidebarBookmark.getAttribute('data-sidebar-bookmark-path');
    else if (sidebarRemote)
      sidebarItem = 'remote:' + sidebarRemote.getAttribute('data-sidebar-remote-name');

    return {
      folder,
      segmentIndex: segmentTarget
        ? parseInt(segmentTarget.getAttribute('data-segment-index')!, 10)
        : null,
      tabIndex: tabTarget ? parseInt(tabTarget.getAttribute('data-tab-index')!, 10) : null,
      sidebarItem,
      paneIndex: paneTarget ? parseInt(paneTarget.getAttribute('data-pane-index')!, 10) : null,
    };
  }
}

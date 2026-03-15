// This file is responsible for the main file browsing interface, acting as a real file explorer.
// It handles tabs, split-view navigation, and rich file operations.
import {
  Component,
  EventEmitter,
  inject,
  Output,
  OnInit,
  OnDestroy,
  ViewChild,
  signal,
  computed,
  HostListener,
  effect,
  untracked,
  DestroyRef,
  Signal,
  WritableSignal,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { combineLatest, firstValueFrom, from, of } from 'rxjs';
import { catchError, finalize, map } from 'rxjs/operators';

import { MatIconModule } from '@angular/material/icon';
import { MatSidenav, MatSidenavModule } from '@angular/material/sidenav';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatDialog } from '@angular/material/dialog';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTooltipModule } from '@angular/material/tooltip';

// CDK
import {
  CdkDrag,
  CdkDragDrop,
  CdkDragEnd,
  CdkDragStart,
  CdkDropList,
  DragDropModule,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import { CdkMenuModule } from '@angular/cdk/menu';

// Services & Types
import {
  AppSettingsService,
  NautilusService,
  PathSelectionService,
  RemoteFileOperationsService,
  RemoteFacadeService,
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
import { IconService, getRemoteNameFromFs } from '@app/services';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import { isLocalPath } from 'src/app/services/remote/utils/remote-config.utils';

import { InputModalComponent } from 'src/app/shared/modals/input-modal/input-modal.component';
import { NotificationService } from '@app/services';
import { RemoteAboutModalComponent } from '../../../modals/remote/remote-about-modal.component';
import { PropertiesModalComponent } from '../../../modals/properties/properties-modal.component';
import { KeyboardShortcutsModalComponent } from '../../../modals/settings/keyboard-shortcuts-modal/keyboard-shortcuts-modal.component';
import { NautilusSidebarComponent } from './sidebar/nautilus-sidebar.component';
import { NautilusToolbarComponent } from './toolbar/nautilus-toolbar.component';
import { NautilusTabsComponent } from './tabs/nautilus-tabs.component';
import { NautilusViewPaneComponent } from './view-pane/nautilus-view-pane.component';
import { NautilusBottomBarComponent } from './bottom-bar/nautilus-bottom-bar.component';

// --- Interfaces ---
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

@Component({
  selector: 'app-nautilus',
  standalone: true,
  imports: [
    DragDropModule,
    CdkMenuModule,
    MatIconModule,
    MatSidenavModule,
    MatButtonModule,
    MatDividerModule,
    MatTooltipModule,
    MatRadioModule,
    MatCheckboxModule,
    NautilusSidebarComponent,
    NautilusToolbarComponent,
    NautilusTabsComponent,
    NautilusViewPaneComponent,
    NautilusBottomBarComponent,
    TranslateModule,
  ],
  templateUrl: './nautilus.component.html',
  styleUrl: './nautilus.component.scss',
})
export class NautilusComponent implements OnInit, OnDestroy {
  // --- Services ---
  private readonly destroyRef = inject(DestroyRef);
  private readonly translate = inject(TranslateService);
  public readonly iconService = inject(IconService);
  private readonly notificationService = inject(NotificationService);
  private readonly nautilusService = inject(NautilusService);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly fileViewerService = inject(FileViewerService);
  private readonly remoteFacadeService = inject(RemoteFacadeService);
  private readonly dialog = inject(MatDialog);

  // --- Outputs ---
  @Output() closeOverlay = new EventEmitter<void>();

  // --- View Children ---
  @ViewChild('sidenav') sidenav!: MatSidenav;

  // --- UI State ---
  public readonly isMobile = signal(window.innerWidth < 680);
  public readonly title = computed(() => {
    const state = this.filePickerState();
    const opts = state.options;
    if (state.isOpen && opts?.selection === 'folders') return 'nautilus.titles.selectFolder';
    if (state.isOpen && opts?.selection === 'files') return 'nautilus.titles.selectFile';
    if (state.isOpen) return 'nautilus.titles.selectItems';
    return 'nautilus.titles.files';
  });
  public readonly isSidenavOpen = signal(true);
  public readonly sidenavMode = computed(() => (this.isMobile() ? 'over' : 'side'));
  // Removed duplicate errorState here
  public readonly isLoading = signal(false);
  private readonly initialLocationApplied = signal(false);

  // --- Picker State ---
  private readonly filePickerState = this.nautilusService.filePickerState;
  public readonly isPickerMode = computed(() => this.filePickerState().isOpen);
  public readonly pickerOptions = computed(
    (): FilePickerConfig =>
      this.filePickerState().options || {
        mode: 'both',
        selection: 'both',
        multi: false,
        minSelection: 0,
      }
  );
  public readonly isConfirmDisabled = computed(() => {
    if (!this.isPickerMode()) return false;
    const opts = this.pickerOptions();
    const selectedCount = this.selectedItems().size;

    // If selecting files specifically, require at least one file to be selected
    if (opts.selection === 'files' && selectedCount === 0) return true;

    // Check minimum selection requirement
    const minSel = opts.minSelection ?? 0;
    if (selectedCount < minSel) return true;

    return false;
  });

  // --- View Configuration ---
  public readonly layout = signal<'grid' | 'list'>('grid');
  public readonly sortKey = signal('name-asc');
  public readonly sortDirection = computed(() => (this.sortKey().endsWith('asc') ? 'asc' : 'desc'));
  public readonly showHidden = signal(false);
  public readonly starredMode = computed(
    () => this.nautilusRemote() === null && this.currentPath() === ''
  );
  public readonly starredModeRight = computed(
    () => this.nautilusRemoteRight() === null && this.currentPathRight() === ''
  );

  public readonly activeStarredMode = computed(() => {
    return this.activePaneIndex() === 0 ? this.starredMode() : this.starredModeRight();
  });

  private readonly savedGridIconSize = signal<number | null>(null);
  private readonly savedListIconSize = signal<number | null>(null);

  private readonly LIST_ICON_SIZES = [16, 24, 32, 48];
  private readonly GRID_ICON_SIZES = [48, 64, 96, 128, 160, 256];
  // Initial value will be set properly in loadSettings based on the loaded layout
  public readonly iconSize = signal(96);

  // Computed: Current icon sizes based on layout
  private readonly currentIconSizes = computed(() =>
    this.layout() === 'list' ? this.LIST_ICON_SIZES : this.GRID_ICON_SIZES
  );

  /** Computed row height for list view virtual scrolling */
  public readonly listRowHeight = computed(() => {
    const size = this.iconSize();
    // Add 16px padding (8px top/bottom) for comfortable spacing
    return size + 16;
  });

  // --- Table Columns ---
  public readonly displayedColumns = ['name', 'size', 'modified', 'star'];

  // --- Selection ---
  public readonly selectedItems = signal<Set<string>>(new Set());
  public readonly selectionSummary = signal('');
  private lastSelectedIndex: number | null = null;
  public readonly isDragging = signal(false);
  /** Folder currently under the drag cursor — used to highlight and target drops. */
  public readonly hoveredFolder = signal<FileBrowserItem | null>(null);
  /** Path-segment index (-1 = root) currently under the drag cursor. null = none. */
  public readonly hoveredSegmentIndex = signal<number | null>(null);
  /** Tab index currently under the drag cursor (file drag hovering over a tab). null = none. */
  public readonly hoveredTabIndex = signal<number | null>(null);
  private _dragMoveUnsub: (() => void) | null = null;
  private _lastDragHitKey = '';

  // --- Navigation State ---
  public readonly nautilusRemote = signal<ExplorerRoot | null>(null);
  public readonly currentPath = signal<string>('');
  private readonly refreshTrigger = signal(0);
  public readonly rawFiles = signal<FileBrowserItem[]>([]);
  public readonly errorState = signal<string | null>(null);

  // --- Clipboard (Move/Copy) ---
  public readonly clipboardItems = signal<
    { remote: string; path: string; name: string; isDir: boolean }[]
  >([]);
  public readonly clipboardMode = signal<'copy' | 'cut' | null>(null);
  public readonly hasClipboard = computed(() => this.clipboardItems().length > 0);

  /** Set of paths currently in the 'cut' clipboard — used for dimming UI */
  public readonly cutItemPaths = computed(() => {
    if (this.clipboardMode() !== 'cut') return new Set<string>();
    return new Set(this.clipboardItems().map(item => `${item.remote}:${item.path}`));
  });

  // --- Undo / Redo ---
  private readonly _undoStack = signal<UndoEntry[]>([]);
  private readonly _redoStack = signal<UndoEntry[]>([]);
  public readonly canUndo = computed(() => this._undoStack().length > 0);
  public readonly canRedo = computed(() => this._redoStack().length > 0);

  public readonly pathSegments = computed(() => {
    const path = this.activePath();
    if (!path) return [];
    const parts = path.split('/').filter(p => p.length > 0);
    return parts.map((name, i) => ({
      name,
      path: parts.slice(0, i + 1).join('/'),
    }));
  });

  public readonly isEditingPath = signal(false);
  public readonly isSearchMode = signal(false);
  public readonly searchFilter = signal('');

  // --- Tabs System ---
  private interfaceTabCounter = 0;
  public readonly tabs = signal<Tab[]>([]);
  public readonly activeTabIndex = signal(0);
  public contextTabIndex: number | null = null;

  public readonly activeRemote = computed(() => {
    return this.activePaneIndex() === 0 ? this.nautilusRemote() : this.nautilusRemoteRight();
  });
  public readonly activePath = computed(() => {
    return this.activePaneIndex() === 0 ? this.currentPath() : this.currentPathRight();
  });
  public readonly activeFiles = computed(() => {
    return this.activePaneIndex() === 0 ? this.files() : this.filesRight();
  });
  public readonly activeIsLoading = computed(() => {
    return this.activePaneIndex() === 0 ? this.isLoading() : this.isLoadingRight();
  });
  public readonly activeErrorState = computed(() => {
    return this.activePaneIndex() === 0 ? this.errorState() : this.errorStateRight();
  });

  public readonly bottomBarOffset = computed(() => {
    let offset = 16;
    if (this.isMobile()) offset += 56;
    if (this.isPickerMode()) offset += 64;
    return offset + 'px';
  });

  public readonly canGoBack = computed(() => {
    const tab = this.tabs()[this.activeTabIndex()];
    if (!tab) return false;
    const pane = this.activePaneIndex() === 0 ? tab.left : tab.right;
    return pane ? pane.historyIndex > 0 : false;
  });
  public readonly canGoForward = computed(() => {
    const tab = this.tabs()[this.activeTabIndex()];
    if (!tab) return false;
    const pane = this.activePaneIndex() === 0 ? tab.left : tab.right;
    return pane ? pane.historyIndex < pane.history.length - 1 : false;
  });

  // --- Split System ---
  public readonly activePaneIndex = signal<0 | 1>(0); // 0=left, 1=right
  public readonly splitDividerPos = signal(50); // percentage
  public readonly isSplitEnabled = computed(() => {
    const tab = this.tabs()[this.activeTabIndex()];
    return !!tab?.right;
  });

  // Right pane navigation state (synced with active tab)
  public readonly nautilusRemoteRight = signal<ExplorerRoot | null>(null);
  public readonly currentPathRight = signal<string>('');
  private readonly refreshTriggerRight = signal(0);
  public readonly isLoadingRight = signal(false);
  public readonly errorStateRight = signal<string | null>(null);
  public readonly selectedItemsRight = signal<Set<string>>(new Set());
  public readonly rawFilesRight = signal<FileBrowserItem[]>([]);

  // Bound methods for view pane component
  public readonly boundGetItemKey = this.getItemKey.bind(this);
  public readonly boundIsItemSelectable = this.isItemSelectable.bind(this);
  public readonly boundTrackByFile = this.trackByFile.bind(this);
  public readonly boundTrackBySortOption = this.trackBySortOption.bind(this);
  public readonly boundFormatRelativeDate = this.formatRelativeDate.bind(this);

  // --- Data ---
  public readonly bookmarks = this.nautilusService.bookmarks; // Direct signal

  // Filtered bookmarks based on picker mode
  public readonly filteredBookmarks = computed(() => {
    let marks = this.bookmarks();
    if (this.isPickerMode()) {
      const cfg = this.pickerOptions();
      marks = marks.filter(b => {
        if (cfg.mode === 'local' && !b.meta.isLocal) return false;
        if (cfg.mode === 'remote' && b.meta.isLocal) return false;
        if (cfg.allowedRemotes && !b.meta.isLocal) {
          return cfg.allowedRemotes.includes(
            this.pathSelectionService.normalizeRemoteName(b.meta.remote ?? '')
          );
        }
        return true;
      });
    }
    return marks;
  });

  // Computed: Local Drives (filtered for picker mode)
  public readonly localDrives = computed<ExplorerRoot[]>(() => {
    const drives = this.nautilusService.localDrives();
    if (this.isPickerMode() && this.pickerOptions().mode === 'remote') return [];
    return drives;
  });

  // Computed: Cloud Remotes (filtered for picker mode)
  public readonly cloudRemotes = computed<ExplorerRoot[]>(() => {
    let list = this.nautilusService.cloudRemotes();
    if (this.isPickerMode() && this.pickerOptions().mode === 'local') return [];
    const allowed = this.pickerOptions().allowedRemotes;
    if (this.isPickerMode() && allowed && allowed.length) {
      list = list.filter(r => allowed.includes(r.name));
    }
    return list;
  });

  public readonly allRemotesLookup = computed(() => [
    ...this.localDrives(),
    ...this.cloudRemotes(),
  ]);

  // Computed: Path String
  public readonly fullPathInput = computed(() => {
    if (this.activeStarredMode()) return '';
    const remote = this.activeRemote();
    const path = this.activePath();
    if (!remote) return path;
    if (remote.isLocal) {
      const separator = remote.name.endsWith('/') ? '' : '/';
      return path ? `${remote.name}${separator}${path}` : remote.name;
    }
    const prefix = remote.name.includes(':') ? remote.name : `${remote.name}:`;
    const cleanPath = path.startsWith('/') ? path.substring(1) : path;
    return path ? `${prefix}${cleanPath}` : prefix;
  });

  // --- File Data Pipeline ---

  /** Unified helper to get files for a specific pane (0=left, 1=right) */
  private getPaneFiles(paneIndex: number): FileBrowserItem[] {
    const isStarred = paneIndex === 0 ? this.starredMode() : this.starredModeRight();
    const rawFiles = paneIndex === 0 ? this.rawFiles() : this.rawFilesRight();
    const cfg = this.pickerOptions();
    const isPicker = this.isPickerMode();

    let files: FileBrowserItem[];

    // 1. Get Source (Raw or Starred)
    if (isStarred) {
      files = this.nautilusService.starredItems();
      if (isPicker) {
        files = files.filter(i => {
          if (cfg.mode === 'local' && !i.meta.isLocal) return false;
          if (cfg.mode === 'remote' && i.meta.isLocal) return false;
          if (cfg.allowedRemotes && !i.meta.isLocal) {
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

    // 2. Filter (Hidden + Search)
    if (!this.showHidden() && !isStarred) {
      files = files.filter(f => !f.entry.Name.startsWith('.'));
    }

    const search = this.searchFilter().toLowerCase().trim();
    if (search) {
      files = files.filter(f => f.entry.Name.toLowerCase().includes(search));
    }

    // 3. Sort
    return this.sortFiles(files);
  }

  public readonly files = computed(() => this.getPaneFiles(0));
  public readonly filesRight = computed(() => this.getPaneFiles(1));

  private sortFiles(files: FileBrowserItem[]): FileBrowserItem[] {
    const list = [...files];
    const [sort, dir] = this.sortKey().split('-');
    const multiplier = dir === 'asc' ? 1 : -1;

    return list.sort((a, b) => {
      // 1. Folders first
      if (a.entry.IsDir !== b.entry.IsDir) return a.entry.IsDir ? -1 : 1;

      // 2. Non-hidden before hidden
      const aHidden = a.entry.Name.startsWith('.');
      const bHidden = b.entry.Name.startsWith('.');
      if (aHidden !== bHidden) return aHidden ? 1 : -1;

      // 3. Sort by selected criteria
      switch (sort) {
        case 'name':
          return (
            a.entry.Name.localeCompare(b.entry.Name, undefined, { numeric: true }) * multiplier
          );
        case 'size':
          return (a.entry.Size - b.entry.Size) * multiplier;
        case 'modified':
          return (
            (new Date(a.entry.ModTime).getTime() - new Date(b.entry.ModTime).getTime()) * multiplier
          );
        default:
          return 0;
      }
    });
  }

  // --- Context Menu State ---
  public readonly contextMenuItem = signal<FileBrowserItem | null>(null);

  // --- Sort Options ---
  public readonly sortOptions = [
    { key: 'name-asc', label: 'nautilus.sort.az' },
    { key: 'name-desc', label: 'nautilus.sort.za' },
    { key: 'modified-desc', label: 'nautilus.sort.lastModified' },
    { key: 'modified-asc', label: 'nautilus.sort.firstModified' },
    { key: 'size-desc', label: 'nautilus.sort.sizeLargest' },
    { key: 'size-asc', label: 'nautilus.sort.sizeSmallest' },
  ];

  constructor() {
    this.setupEffects();
    this.subscribeToSettings();

    // Initialize file loading for both panes
    this.loadFilesForPane(
      this.nautilusRemote,
      this.currentPath,
      this.refreshTrigger,
      this.rawFiles,
      this.isLoading,
      this.errorState
    );

    this.loadFilesForPane(
      this.nautilusRemoteRight,
      this.currentPathRight,
      this.refreshTriggerRight,
      this.rawFilesRight,
      this.isLoadingRight,
      this.errorStateRight
    );
  }

  private loadFilesForPane(
    remote: Signal<ExplorerRoot | null>,
    path: Signal<string>,
    trigger: Signal<number>,
    rawFiles: WritableSignal<FileBrowserItem[]>,
    loading: WritableSignal<boolean>,
    error: WritableSignal<string | null>
  ): void {
    effect(() => {
      const r = remote();
      const p = path();
      trigger(); // track trigger

      const targetTabId = this.tabs()[this.activeTabIndex()]?.id;
      untracked(() => {
        if (!r) {
          rawFiles.set([]);
          return;
        }
        loading.set(true);
        let fsName = r.name;
        if (!r.isLocal) {
          fsName = this.pathSelectionService.normalizeRemoteForRclone(r.name);
        }
        error.set(null);

        from(this.remoteOps.getRemotePaths(fsName, p, {}, 'nautilus'))
          .pipe(
            map(res => {
              const list = res.list || [];
              return list.map(
                f =>
                  ({
                    entry: f,
                    meta: {
                      remote: this.pathSelectionService.normalizeRemoteName(fsName),
                      isLocal: r.isLocal,
                      remoteType: r.type,
                    },
                  }) as FileBrowserItem
              );
            }),
            catchError(err => {
              console.error('Error fetching files:', err);
              error.set(err || this.translate.instant('nautilus.errors.loadFailed'));
              // Only show notification for active pane or if it's a critical error
              this.notificationService.showError(
                this.translate.instant('nautilus.errors.loadFailed')
              );
              return of([]);
            }),
            finalize(() => loading.set(false)),
            takeUntilDestroyed(this.destroyRef)
          )
          .subscribe(files => {
            rawFiles.set(files);
            // Sync back to tab state
            const t = this.tabs().find(tab => tab.id === targetTabId);
            if (t) {
              const pane = remote === this.nautilusRemote ? t.left : t.right;
              if (pane) {
                pane.rawFiles.set(files);
                pane.error.set(error());
                pane.isLoading.set(loading());
              }
            }
          });
      });
    });
  }

  async ngOnInit(): Promise<void> {
    await this.setupInitialTab();
    this.setupEventListeners();
  }

  ngOnDestroy(): void {
    this.removeEventListeners();
  }

  private setupEffects(): void {
    // Removed no-op effect

    // Fallback: Apply initialLocation if data wasn't ready during setupInitialTab
    effect(() => {
      const open = this.isPickerMode();
      const applied = this.initialLocationApplied();
      const cfg = this.pickerOptions();

      // Only apply if picker is open, not yet applied, and has an initial location
      if (open && !applied && cfg.initialLocation) {
        if (!this.isDataReadyForConfig(cfg)) return;
        if (this.isLocationAllowedByConfig(cfg.initialLocation, cfg)) {
          this.navigateToPath(cfg.initialLocation);
          this.initialLocationApplied.set(true);
        }
      }

      // Reset flag when picker closes
      if (!open && applied) this.initialLocationApplied.set(false);
    });

    // Handle dynamic remote selection (e.g. from Tray or external actions)
    effect(() => {
      const selectedMap = this.nautilusService.selectedNautilusRemote();
      if (selectedMap) {
        untracked(() => {
          const remote = this.allRemotesLookup().find(r => r.name === selectedMap);
          if (remote) {
            if (this.tabs().length > 0) {
              this.selectRemote(remote);
              this.nautilusService.selectedNautilusRemote.set(null);
            }
          }
        });
      }
    });

    // Handle dynamic path navigation (e.g. from Debug menu)
    effect(() => {
      const targetPath = this.nautilusService.targetPath();
      if (targetPath) {
        untracked(() => {
          const parsed = this.parseLocationToRemoteAndPath(targetPath);
          if (parsed) {
            if (this.tabs().length > 0) {
              this._navigate(parsed.remote, parsed.path, true);
              this.nautilusService.targetPath.set(null);
            }
          }
        });
      }
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
      const cfg = pickerState.options;
      const drives = this.nautilusService.localDrives();
      const remotes = this.cloudRemotes();
      if (cfg.mode === 'remote') {
        initialRemote =
          (cfg.allowedRemotes?.length
            ? remotes.find(r => cfg.allowedRemotes?.includes(r.name))
            : remotes[0]) || null;
      } else {
        initialRemote = drives[0] || null;
      }
    }

    // Priority 4: Standard fallback
    initialRemote ??= this.nautilusService.localDrives()[0] || null;

    this.createTab(initialRemote, initialPath);
  }

  /**
   * Parses a location string (like "gdrive:Photos/2024" or "/home/user") into remote and path.
   * Returns null if parsing fails.
   */
  private parseLocationToRemoteAndPath(
    rawInput: string
  ): { remote: ExplorerRoot; path: string } | null {
    let normalized = rawInput.replace(/\\/g, '/');
    if (normalized.endsWith('/') && normalized.length > 1) {
      normalized = normalized.slice(0, -1);
    }

    const known = this.allRemotesLookup();

    // Local Drive Match (Windows C:\ or mounted drives)
    const driveMatch = known.find(
      r => r.isLocal && normalized.toLowerCase().startsWith(r.name.toLowerCase())
    );
    if (driveMatch) {
      const remaining = normalized.substring(driveMatch.name.length);
      const cleanPath = remaining.startsWith('/') ? remaining.substring(1) : remaining;
      return { remote: driveMatch, path: cleanPath };
    }

    // Rclone Syntax Match (remote:path)
    const colonIdx = normalized.indexOf(':');
    if (colonIdx > -1) {
      const rName = normalized.substring(0, colonIdx);
      const rPath = normalized.substring(colonIdx + 1);
      const remoteMatch = known.find(r => r.name === rName);
      const targetRemote: ExplorerRoot = remoteMatch || {
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
      if (root) {
        return { remote: root, path: normalized.substring(1) };
      }
    }

    return null;
  }

  private isLocationAllowedByConfig(loc: string, cfg: FilePickerConfig): boolean {
    const hasColon = loc.includes(':');
    if (cfg.mode === 'local' && hasColon) return false;
    if (cfg.mode === 'remote') {
      if (!hasColon) return false;
      const remote = getRemoteNameFromFs(loc);
      if (cfg.allowedRemotes && cfg.allowedRemotes.length) {
        return cfg.allowedRemotes.includes(remote);
      }
      return true;
    }
    // mode === 'both'
    if (hasColon && cfg.allowedRemotes && cfg.allowedRemotes.length) {
      const remote = getRemoteNameFromFs(loc);
      return cfg.allowedRemotes.includes(remote);
    }
    return true;
  }

  private isDataReadyForConfig(cfg: FilePickerConfig): boolean {
    const hasColon = !!cfg.initialLocation && cfg.initialLocation.includes(':');
    const localCount = this.localDrives().length;
    const remoteList = this.cloudRemotes();
    const remoteCount = remoteList.length;

    if (cfg.initialLocation) {
      if (hasColon) {
        if (remoteCount === 0) return false;
        if (cfg.allowedRemotes && cfg.allowedRemotes.length) {
          const r = getRemoteNameFromFs(cfg.initialLocation);
          return cfg.allowedRemotes.includes(r) && remoteList.some(x => x.name === r);
        }
        return true;
      }
      return localCount > 0;
    }

    if (cfg.mode === 'local') return localCount > 0;
    if (cfg.mode === 'remote') {
      if (remoteCount === 0) return false;
      if (cfg.allowedRemotes && cfg.allowedRemotes.length) {
        const allow = cfg.allowedRemotes;
        return remoteList.some(x => allow?.includes(x.name));
      }
      return true;
    }
    return true;
  }

  private setupEventListeners(): void {
    window.addEventListener('keydown', this._globalEscapeHandler, true);
  }

  private removeEventListeners(): void {
    window.removeEventListener('keydown', this._globalEscapeHandler, true);
  }

  // --- Drag & Drop ---
  public readonly canAcceptFile = (item: CdkDrag<FileBrowserItem>): boolean => {
    const data = item.data;
    return !!(data?.entry && data.entry.Path);
  };

  canDropOnStarred = (item: CdkDrag<FileBrowserItem>): boolean => {
    return this.canAcceptFile(item);
  };

  canDropOnBookmarks = (item: CdkDrag<FileBrowserItem>): boolean => {
    return this.canAcceptFile(item) && !!item.data.entry.IsDir;
  };

  canDropOnBookmark = (item: CdkDrag<FileBrowserItem>): boolean => {
    return this.canAcceptFile(item);
  };

  canDropOnFolder = (
    item: CdkDrag<FileBrowserItem>,
    dropList: CdkDropList<FileBrowserItem>
  ): boolean => {
    if (!this.canAcceptFile(item)) return false;
    const targetItem = dropList.data;
    if (!targetItem?.entry?.IsDir) return false;
    // Prevent dropping onto self
    return item.data.entry.Path !== targetItem.entry.Path;
  };

  private getItemsToProcess(draggedItem: FileBrowserItem): FileBrowserItem[] {
    const currentSelected = this.selectedItems();
    const isDraggedSelected = currentSelected.has(this.getItemKey(draggedItem));

    if (isDraggedSelected) {
      // Return all selected items that belong to the current view
      const allFiles = this.activePaneIndex() === 0 ? this.files() : this.filesRight();
      return allFiles.filter(item => currentSelected.has(this.getItemKey(item)));
    }

    return [draggedItem];
  }

  onDragStarted(event: CdkDragStart<FileBrowserItem>): void {
    this.isDragging.set(true);
    this._lastDragHitKey = '';
    const sub = event.source.moved.subscribe(moveEvt => this._onDragMove(moveEvt.pointerPosition));
    this._dragMoveUnsub = (): void => sub.unsubscribe();
  }

  onDragEnded(event?: CdkDragEnd<FileBrowserItem>): void {
    // If the drag was released over a tab (outside any accepting drop list),
    // cdkDropListDropped never fires — handle the operation here instead.
    // Re-hit-test at drop point for the same reliability reason as onDropToCurrentDirectory.
    const freshHit = event?.dropPoint ? this._resolveDropHit(event.dropPoint) : null;
    const tabIdx = freshHit?.tabIndex ?? this.hoveredTabIndex();
    if (tabIdx !== null && event) {
      const items = this.getItemsToProcess(event.source.data);
      const tab = this.tabs()[tabIdx];
      if (items.length && tab?.left.remote) {
        const sourceRemoteName = items[0].meta.remote ?? '';
        const isSameRemote =
          this.pathSelectionService.normalizeRemoteName(sourceRemoteName) ===
          this.pathSelectionService.normalizeRemoteName(tab.left.remote.name);
        this.performFileOperations(
          items,
          tab.left.remote,
          tab.left.path,
          isSameRemote ? 'move' : 'copy'
        );
      }
    }
    this.isDragging.set(false);
    this._dragMoveUnsub?.();
    this._dragMoveUnsub = null;
    this._lastDragHitKey = '';
    this.hoveredFolder.set(null);
    this.hoveredSegmentIndex.set(null);
    this.hoveredTabIndex.set(null);
  }

  /** Unified processor for Drag & Drop operations */
  private async processDrop(
    event: CdkDragDrop<any, any>,
    target: { remote: ExplorerRoot | null; path: string }
  ): Promise<void> {
    const items = this.getItemsToProcess(event.item.data);
    if (!items.length || !target.remote) return;

    const sourceRemote = items[0].meta.remote ?? '';
    const isSameRemote =
      this.pathSelectionService.normalizeRemoteName(sourceRemote) ===
      this.pathSelectionService.normalizeRemoteName(target.remote.name);

    await this.performFileOperations(
      items,
      target.remote,
      target.path,
      isSameRemote ? 'move' : 'copy'
    );
  }

  onDropToStarred(event: CdkDragDrop<any, FileBrowserItem[]>): void {
    const items = this.getItemsToProcess(event.item.data);
    items.forEach(item => !this.isStarred(item) && this.toggleStar(item));
  }

  onDropToLocal(event: CdkDragDrop<any, FileBrowserItem[]>): void {
    if ((event.previousContainer as any) !== (event.container as any)) {
      const items = this.getItemsToProcess(event.item.data);
      items.forEach(item => item.entry.IsDir && this.addBookmark(item));
    }
  }

  async onDropToBookmark(
    event: CdkDragDrop<FileBrowserItem, FileBrowserItem[]>,
    bookmark: FileBrowserItem
  ): Promise<void> {
    const targetRemote = this.allRemotesLookup().find(
      r =>
        this.pathSelectionService.normalizeRemoteName(r.name) ===
        this.pathSelectionService.normalizeRemoteName(bookmark.meta.remote)
    );
    await this.processDrop(event, {
      remote: targetRemote ?? null,
      path: bookmark.entry.Path,
    });
  }

  async onDropToRemote(
    event: CdkDragDrop<ExplorerRoot, FileBrowserItem[]>,
    targetRemote: ExplorerRoot
  ): Promise<void> {
    const isSidebarMove =
      (event.previousContainer as any) === (event.container as any) &&
      (event.container as any).id === 'sidebar';
    if (isSidebarMove) return;

    await this.processDrop(event, { remote: targetRemote, path: '' });
  }

  async onDropToFolder(
    event: CdkDragDrop<FileBrowserItem[]>,
    targetFolder: FileBrowserItem
  ): Promise<void> {
    const targetRemote = this.allRemotesLookup().find(
      r =>
        this.pathSelectionService.normalizeRemoteName(r.name) ===
        this.pathSelectionService.normalizeRemoteName(targetFolder.meta.remote)
    );
    await this.processDrop(event, { remote: targetRemote ?? null, path: targetFolder.entry.Path });
  }

  async onDropToCurrentDirectory(
    event: CdkDragDrop<FileBrowserItem[]>,
    paneIndex: number
  ): Promise<void> {
    const targetRemote = paneIndex === 0 ? this.nautilusRemote() : this.nautilusRemoteRight();
    if (!targetRemote) return;

    const resolved = this._resolveDropHit(event.dropPoint);
    const folder = resolved.folder ?? this.hoveredFolder();
    const segIdx = resolved.segmentIndex ?? this.hoveredSegmentIndex();

    let targetPath: string;
    if (folder) {
      targetPath = folder.entry.Path;
    } else if (segIdx !== null) {
      targetPath = segIdx < 0 ? '' : (this.pathSegments()[segIdx]?.path ?? '');
    } else {
      if (event.previousContainer === event.container) return;
      targetPath = paneIndex === 0 ? this.currentPath() : this.currentPathRight();
    }

    await this.processDrop(event, { remote: targetRemote, path: targetPath });
  }

  // --- Drag hover hit-testing (cdkDragMoved) ---

  /**
   * Hit-tests a screen position and returns which folder/segment/tab the pointer is over.
   * Used both during drag-move (for hover highlights) and at drop-time (to get the final target).
   */
  private _resolveDropHit(pos: { x: number; y: number }): {
    folder: FileBrowserItem | null;
    segmentIndex: number | null;
    tabIndex: number | null;
  } {
    const elements = document.elementsFromPoint(pos.x, pos.y) as HTMLElement[];
    const hit = elements.find(
      el =>
        !el.classList.contains('cdk-drag-dragging') &&
        !el.classList.contains('cdk-drag-preview') &&
        (el.hasAttribute('data-folder-path') ||
          el.hasAttribute('data-segment-index') ||
          el.hasAttribute('data-tab-index'))
    ) as HTMLElement | undefined;

    const folderPath = hit?.getAttribute('data-folder-path') ?? null;
    const segmentAttr = hit?.getAttribute('data-segment-index') ?? null;
    const tabAttr = hit?.getAttribute('data-tab-index') ?? null;

    if (folderPath) {
      const allFiles = [...this.files(), ...this.filesRight()];
      return {
        folder: allFiles.find(f => f.entry.Path === folderPath) ?? null,
        segmentIndex: null,
        tabIndex: null,
      };
    }
    if (segmentAttr !== null) {
      return { folder: null, segmentIndex: Number(segmentAttr), tabIndex: null };
    }
    if (tabAttr !== null) {
      return { folder: null, segmentIndex: null, tabIndex: Number(tabAttr) };
    }
    return { folder: null, segmentIndex: null, tabIndex: null };
  }

  private _onDragMove(pos: { x: number; y: number }): void {
    const { folder, segmentIndex, tabIndex } = this._resolveDropHit(pos);
    const hitKey =
      folder?.entry.Path ??
      (segmentIndex !== null ? `seg:${segmentIndex}` : tabIndex !== null ? `tab:${tabIndex}` : '');

    if (hitKey === this._lastDragHitKey) return;
    this._lastDragHitKey = hitKey;

    this.hoveredFolder.set(folder);
    this.hoveredSegmentIndex.set(segmentIndex);
    this.hoveredTabIndex.set(tabIndex);
  }

  /** Drop on a path breadcrumb segment in the toolbar. */
  async onDropToSegment(event: CdkDragDrop<FileBrowserItem[]>): Promise<void> {
    const paneIndex = this.activePaneIndex();
    const targetRemote = paneIndex === 0 ? this.nautilusRemote() : this.nautilusRemoteRight();
    if (!targetRemote) return;

    // CDK drops onto the exact button — read segment index directly from it
    const segIdx = Number(event.container.element.nativeElement.getAttribute('data-segment-index'));
    const targetPath = segIdx < 0 ? '' : (this.pathSegments()[segIdx]?.path ?? '');

    const currentPath = paneIndex === 0 ? this.currentPath() : this.currentPathRight();
    if (targetPath === currentPath) return;

    await this.processDrop(event, { remote: targetRemote, path: targetPath });
  }

  // --- Bookmarks ---
  addBookmark(item: FileBrowserItem): void {
    this.nautilusService.toggleItem('bookmarks', item);
  }

  removeBookmark(bookmark: FileBrowserItem): void {
    this.nautilusService.toggleItem('bookmarks', bookmark);
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

  // --- Navigation ---
  selectRemote(remote: ExplorerRoot | null): void {
    if (!remote) return;
    this._navigate(remote, '', true);
  }

  updatePath(newPath: string): void {
    this._navigate(this.activeRemote(), newPath, true);
  }

  navigateToSegment(index: number): void {
    const seg = this.pathSegments()[index];
    if (seg) {
      this.updatePath(seg.path);
    }
  }

  navigateToPath(rawInput: string): void {
    this.isEditingPath.set(false);

    // Try to parse as absolute path (remote or local)
    const parsed = this.parseLocationToRemoteAndPath(rawInput);
    if (parsed) {
      this._navigate(parsed.remote, parsed.path, true);
      return;
    }

    // Fallback: treat as relative path from current location
    const currentPath = this.activePath();
    const normalized = rawInput.replace(/\\/g, '/');
    const newPath = currentPath ? `${currentPath}/${normalized}` : normalized;
    this.updatePath(newPath);
  }

  public navigateTo(item: FileBrowserItem, isNewTab = false): void {
    const idx = this.activeTabIndex();
    const tab = this.tabs()[idx];
    if (!tab) return;
    const pIdx = this.activePaneIndex();
    const pane = pIdx === 0 ? tab.left : tab.right;
    if (!pane) return;

    if (item.entry.IsDir) {
      if (!isNewTab) {
        // If it's a directory, navigate current pane
        this._navigate(pane.remote, item.entry.Path, true);
      } else {
        // Otherwise open in new tab (uses current pane remote as context)
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
    const computedTitle =
      currentStarredMode && !remote
        ? 'nautilus.titles.starred'
        : path.split('/').pop() || remote?.label || 'nautilus.titles.files';

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

    // Sync active state signals
    const targetRemote = pIdx === 0 ? this.nautilusRemote : this.nautilusRemoteRight;
    const targetPath = pIdx === 0 ? this.currentPath : this.currentPathRight;
    const targetSelection = pIdx === 0 ? this.selectedItems : this.selectedItemsRight;

    targetRemote.set(remote);
    targetPath.set(path);
    targetSelection.set(new Set<string>());

    this.updateSelectionSummary();
  }

  /**
   * Creates a new helper for initializing PaneState
   */
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

  // --- Tabs ---
  createTab(remote: ExplorerRoot | null, path = ''): void {
    const id = ++this.interfaceTabCounter;
    const initialTitle = path.split('/').pop() || remote?.label || (!remote ? 'Starred' : 'Files');
    const t: Tab = {
      id,
      title: initialTitle,
      left: this.createPaneState(remote, path),
    };
    this.tabs.update(list => [...list, t]);
    this.activeTabIndex.set(this.tabs().length - 1);
    this.switchTab(this.tabs().length - 1);
  }

  closeTab(i: number): void {
    if (i < 0 || i >= this.tabs().length) return;
    this.tabs.update(list => list.filter((_, idx) => idx !== i));
    if (this.tabs().length === 0) {
      this.closeOverlay.emit();
      return;
    }
    let newIndex = this.activeTabIndex();
    if (i <= newIndex) newIndex = Math.max(0, newIndex - 1);
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
    this.updateSelectionSummary();
  }

  public toggleSplit(): void {
    const idx = this.activeTabIndex();
    const tab = this.tabs()[idx];
    if (!tab) return;

    this.tabs.update(list =>
      list.map((t, i) => {
        if (i !== idx) return t;
        if (t.right) {
          const rest = { ...t };
          delete (rest as Partial<Tab>).right;
          return rest as Tab;
        }
        return {
          ...t,
          right: this.createPaneState(t.left.remote, t.left.path),
        };
      })
    );

    const updatedTab = this.tabs()[idx];
    if (updatedTab.right) {
      this.syncPaneSignals(1, updatedTab.right);
    } else {
      this.activePaneIndex.set(0);
    }
  }

  /**
   * Synchronizes top-level signals with a specific pane state.
   */
  private syncPaneSignals(paneIndex: number, state: PaneState): void {
    const isLeft = paneIndex === 0;
    const remote = isLeft ? this.nautilusRemote : this.nautilusRemoteRight;
    const path = isLeft ? this.currentPath : this.currentPathRight;
    const selection = isLeft ? this.selectedItems : this.selectedItemsRight;
    const rawFiles = isLeft ? this.rawFiles : this.rawFilesRight;
    const loading = isLeft ? this.isLoading : this.isLoadingRight;
    const error = isLeft ? this.errorState : this.errorStateRight;

    remote.set(state.remote);
    path.set(state.path);
    selection.set(state.selection);
    rawFiles.set(state.rawFiles());
    loading.set(state.isLoading());
    error.set(state.error());
  }

  public switchPane(index: 0 | 1): void {
    if (!this.isSplitEnabled() && index === 1) return;
    this.activePaneIndex.set(index);
    this.updateSelectionSummary();
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
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  public closeOtherTabs(index: number): void {
    const list = this.tabs();
    if (index < 0 || index >= list.length) return;
    const targetTab = list[index];
    this.tabs.set([targetTab]);
    this.switchTab(0);
  }

  public closeTabsToRight(index: number): void {
    const list = this.tabs();
    if (index < 0 || index >= list.length) return;
    this.tabs.set(list.slice(0, index + 1));
    if (this.activeTabIndex() > index) {
      this.switchTab(index);
    }
  }

  public duplicateTab(index: number): void {
    const list = this.tabs();
    if (index < 0 || index >= list.length) return;
    const tab = list[index];
    this.createTab(tab.left.remote, tab.left.path);
  }

  public onTabMiddleClick(event: MouseEvent, index: number): void {
    if (event.button === 1) {
      // Middle mouse button
      event.preventDefault();
      this.closeTab(index);
    }
  }

  public moveTab(previousIndex: number, currentIndex: number): void {
    this.tabs.update(list => {
      const newList = [...list];
      moveItemInArray(newList, previousIndex, currentIndex);
      return newList;
    });

    // If the moved tab was the active one, update its index
    const activeIdx = this.activeTabIndex();
    if (activeIdx === previousIndex) {
      this.activeTabIndex.set(currentIndex);
    } else if (previousIndex < activeIdx && currentIndex >= activeIdx) {
      this.activeTabIndex.set(activeIdx - 1);
    } else if (previousIndex > activeIdx && currentIndex <= activeIdx) {
      this.activeTabIndex.set(activeIdx + 1);
    }
  }

  goBack(): void {
    const idx = this.activeTabIndex();
    const tab = this.tabs()[idx];
    if (!tab) return;
    const pIdx = this.activePaneIndex();
    const pane = pIdx === 0 ? tab.left : tab.right;
    if (pane && pane.historyIndex > 0) {
      const newHistoryIndex = pane.historyIndex - 1;
      const entry = pane.history[newHistoryIndex];

      this.tabs.update(tabs =>
        tabs.map((t, i) => {
          if (i !== idx) return t;
          if (pIdx === 0) {
            return { ...t, left: { ...t.left, historyIndex: newHistoryIndex } };
          } else {
            return {
              ...t,
              right: t.right ? { ...t.right, historyIndex: newHistoryIndex } : undefined,
            };
          }
        })
      );
      this._navigate(entry.remote, entry.path, false);
    }
  }

  goForward(): void {
    const idx = this.activeTabIndex();
    const tab = this.tabs()[idx];
    if (!tab) return;
    const pIdx = this.activePaneIndex();
    const pane = pIdx === 0 ? tab.left : tab.right;
    if (pane && pane.historyIndex < pane.history.length - 1) {
      const newHistoryIndex = pane.historyIndex + 1;
      const entry = pane.history[newHistoryIndex];

      this.tabs.update(tabs =>
        tabs.map((t, i) => {
          if (i !== idx) return t;
          if (pIdx === 0) {
            return { ...t, left: { ...t.left, historyIndex: newHistoryIndex } };
          } else {
            return {
              ...t,
              right: t.right ? { ...t.right, historyIndex: newHistoryIndex } : undefined,
            };
          }
        })
      );
      this._navigate(entry.remote, entry.path, false);
    }
  }

  // --- Interactions ---
  refresh(): void {
    if (this.activePaneIndex() === 0) {
      this.refreshTrigger.update(v => v + 1);
    } else {
      this.refreshTriggerRight.update(v => v + 1);
    }
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

      // If the item is not already selected, select only this item on right click
      if (!currentSelection.has(this.getItemKey(item))) {
        const newSelection = new Set<string>([this.getItemKey(item)]);
        this.syncSelection(newSelection);
        this.lastSelectedIndex = (pIdx === 0 ? this.files() : this.filesRight()).findIndex(
          f => this.getItemKey(f) === this.getItemKey(item)
        );
      }
    }
  }

  openContextMenuOpen(): void {
    const item = this.contextMenuItem();
    if (!item) return;
    this.navigateTo(item);
  }

  // Removed duplicate navigateTo from here

  openContextMenuOpenInNewTab(): void {
    const item = this.contextMenuItem();
    if (!item || !item.entry.IsDir) return;

    // Try to find remote context:
    // 1. Active remote in view
    let root = this.activeRemote();

    // 2. If in starred view (no active remote), infer from item meta
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

  openContextMenuCopyPath(): void {
    const item = this.contextMenuItem();
    const remote = this.activeRemote();
    if (!item || !remote) return;

    const cleanRemote = remote.isLocal
      ? remote.name
      : this.pathSelectionService.normalizeRemoteForRclone(remote.name) + ':';

    // Local paths usually don't want double slashes if remoteName is just "/"
    const full = `${cleanRemote}${item.entry.Path}`.replace('//', '/');

    navigator.clipboard?.writeText(full);
  }

  openContextMenuSelectToggle(): void {
    const item = this.contextMenuItem();
    if (item) {
      const sel = new Set(this.selectedItems());
      const key = this.getItemKey(item);
      if (sel.has(key)) sel.delete(key);
      else sel.add(key);
      this.syncSelection(sel);
    }
  }

  onSidebarRequestProperties(item: FileBrowserItem): void {
    this.openPropertiesDialog('contextMenu', item);
  }

  private getNormalizedRemoteName(remote: ExplorerRoot | null): string {
    if (!remote) return '';
    return !remote.isLocal
      ? this.pathSelectionService.normalizeRemoteForRclone(remote.name)
      : remote.name;
  }

  openPropertiesDialog(source: 'contextMenu' | 'bookmark', itemOverride?: FileBrowserItem): void {
    const activeRemote = this.activeRemote();
    const item = itemOverride || this.contextMenuItem();

    // For bookmark, require item; for context menu, fallback to current path
    if (source === 'bookmark' && !item) return;

    const path = item?.entry.Path || this.activePath();
    const isLocal = item?.meta.isLocal ?? activeRemote?.isLocal ?? true;

    // Normalize remote name for API calls
    let remoteName = item?.meta.remote || activeRemote?.name;
    if (remoteName && !isLocal) {
      remoteName = this.pathSelectionService.normalizeRemoteForRclone(remoteName);
    }

    // Get features from RemoteFacadeService
    const baseName = this.pathSelectionService.normalizeRemoteName(
      item?.meta.remote || activeRemote?.name || ''
    );
    const features = this.remoteFacadeService.featuresSignal(baseName)() as RemoteFeatures;

    this.dialog.open(PropertiesModalComponent, {
      data: {
        remoteName: remoteName,
        path: path,
        isLocal: isLocal,
        item: item?.entry,
        remoteType: item?.meta.remoteType || activeRemote?.type,
        features: features,
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

      // Correctly construct the new path base on directory nesting
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
    const normalized = !remote.isLocal
      ? this.pathSelectionService.normalizeRemoteForRclone(remote.name)
      : remote.name;
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
      {
        icon: 'trash',
        iconColor: 'warn',
        iconClass: 'destructive',
        confirmButtonColor: 'warn',
      }
    );
    if (!confirmed) return;
    try {
      const normalized = !r.isLocal
        ? this.pathSelectionService.normalizeRemoteForRclone(r.name)
        : r.name;
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

  public openShortcutsModal(): void {
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

    // If context menu was opened on an unselected item, delete only that item
    if (contextItem && !selection.has(this.getItemKey(contextItem))) {
      itemsToDelete = [contextItem];
    }

    if (itemsToDelete.length === 0) return;

    const isMultiple = itemsToDelete.length > 1;
    const title = this.translate.instant('nautilus.modals.delete.title');
    const message = isMultiple
      ? this.translate.instant('nautilus.modals.delete.messageMultiple', {
          count: itemsToDelete.length,
        })
      : this.translate.instant('nautilus.modals.delete.messageSingle', {
          name: itemsToDelete[0].entry.Name,
        });

    const confirmed = await this.notificationService.confirmModal(
      title,
      message,
      undefined,
      undefined,
      {
        icon: 'trash',
        iconColor: 'warn',
      }
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

  // --- Clipboard Operations ---

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

  public copyItems(): void {
    this.prepareClipboardItems('copy');
  }

  public cutItems(): void {
    this.prepareClipboardItems('cut');
  }

  public async pasteItems(): Promise<void> {
    const clipboardData = this.clipboardItems();
    const mode = this.clipboardMode();
    const dstRemote = this.activeRemote();
    const dstPath = this.activePath();

    if (clipboardData.length === 0 || !dstRemote || !mode) return;

    // Convert clipboard items to FileBrowserItem-like for performFileOperations
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

    if (mode === 'cut') {
      this.clearClipboard();
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
        const isDir = item.entry.IsDir;

        if (mode === 'copy') {
          if (isDir) {
            await this.remoteOps.copyDirectory(
              normalizedSrcRemote,
              item.entry.Path,
              normalizedDstRemote,
              destinationFile,
              'nautilus'
            );
          } else {
            await this.remoteOps.copyFile(
              normalizedSrcRemote,
              item.entry.Path,
              normalizedDstRemote,
              destinationFile,
              'nautilus'
            );
          }
        } else {
          if (isDir) {
            await this.remoteOps.moveDirectory(
              normalizedSrcRemote,
              item.entry.Path,
              normalizedDstRemote,
              destinationFile,
              'nautilus'
            );
          } else {
            await this.remoteOps.moveFile(
              normalizedSrcRemote,
              item.entry.Path,
              normalizedDstRemote,
              destinationFile,
              'nautilus'
            );
          }
        }

        succeededItems.push({
          srcRemote: normalizedSrcRemote,
          srcPath: item.entry.Path,
          dstRemote: normalizedDstRemote,
          dstFullPath: destinationFile,
          isDir: !!isDir,
          name: item.entry.Name,
        });
      } catch (e) {
        console.error(`${mode} failed for ${item.entry.Path}`, e);
        failCount++;
      }
    }

    if (succeededItems.length > 0) {
      const MAX_STACK = 20;
      this._undoStack.update(s => [...s.slice(-(MAX_STACK - 1)), { mode, items: succeededItems }]);
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
        this.translate.instant('nautilus.notifications.pasteComplete')
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
          // Undo copy → delete the destination file/dir
          if (item.isDir) {
            await this.remoteOps.purgeDirectory(item.dstRemote, item.dstFullPath, 'nautilus');
          } else {
            await this.remoteOps.deleteFile(item.dstRemote, item.dstFullPath, 'nautilus');
          }
        } else {
          // Undo move → move back to original location
          if (item.isDir) {
            await this.remoteOps.moveDirectory(
              item.dstRemote,
              item.dstFullPath,
              item.srcRemote,
              item.srcPath,
              'nautilus'
            );
          } else {
            await this.remoteOps.moveFile(
              item.dstRemote,
              item.dstFullPath,
              item.srcRemote,
              item.srcPath,
              'nautilus'
            );
          }
        }
      } catch (e) {
        console.error('undo failed for', item.dstFullPath, e);
        failCount++;
      }
    }

    this._redoStack.update(s => [...s.slice(-19), entry]);
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
        if (entry.mode === 'copy') {
          if (item.isDir) {
            await this.remoteOps.copyDirectory(
              item.srcRemote,
              item.srcPath,
              item.dstRemote,
              item.dstFullPath,
              'nautilus'
            );
          } else {
            await this.remoteOps.copyFile(
              item.srcRemote,
              item.srcPath,
              item.dstRemote,
              item.dstFullPath,
              'nautilus'
            );
          }
        } else {
          if (item.isDir) {
            await this.remoteOps.moveDirectory(
              item.srcRemote,
              item.srcPath,
              item.dstRemote,
              item.dstFullPath,
              'nautilus'
            );
          } else {
            await this.remoteOps.moveFile(
              item.srcRemote,
              item.srcPath,
              item.dstRemote,
              item.dstFullPath,
              'nautilus'
            );
          }
        }
      } catch (e) {
        console.error('redo failed for', item.srcPath, e);
        failCount++;
      }
    }

    this._undoStack.update(s => [...s.slice(-19), entry]);
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

  public clearClipboard(): void {
    this.clipboardItems.set([]);
    this.clipboardMode.set(null);
  }

  private getSelectedItemsList(): FileBrowserItem[] {
    const selection = this.selectedItems();
    return this.activeFiles().filter(item => selection.has(this.getItemKey(item)));
  }

  private hasFolderInSelection(): boolean {
    const selection = this.selectedItems();
    return this.activeFiles().some(f => selection.has(this.getItemKey(f)) && f.entry.IsDir);
  }

  async removeEmptyDirs(): Promise<void> {
    const remote = this.activeRemote();
    if (!remote) return;

    // Use context menu item or selected folder
    const selection = this.selectedItems();
    const item =
      this.contextMenuItem() ||
      this.activeFiles().find(f => selection.has(this.getItemKey(f)) && f.entry.IsDir);
    if (!item || !item.entry.IsDir) return;

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

  // No longer needed

  // --- Utilities ---
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

  public getItemKey(item: FileBrowserItem | null): string {
    if (!item) return '';
    return `${item.meta.remote}:${item.entry.Path}`;
  }

  async openFilePreview(item: FileBrowserItem): Promise<void> {
    const currentRemote = this.nautilusRemote();
    const actualRemoteName = item.meta.remote || currentRemote?.name;

    if (!actualRemoteName) {
      this.notificationService.showError(this.translate.instant('nautilus.errors.openFileFailed'));
      return;
    }

    // Get isLocal from features (or item meta) with fallback
    const baseName = this.pathSelectionService.normalizeRemoteName(actualRemoteName);
    const features = this.remoteFacadeService.featuresSignal(baseName)() as RemoteFeatures;
    const isLocal =
      features?.isLocal ??
      item.meta.isLocal ??
      currentRemote?.isLocal ??
      isLocalPath(actualRemoteName);

    // Pass Entry[] to the viewer
    const entries = this.files().map(f => f.entry);
    const idx = this.files().findIndex(f => f.entry.Path === item.entry.Path);
    this.fileViewerService.open(entries, idx, actualRemoteName, isLocal);
  }

  confirmSelection(): void {
    let items = this.getSelectedItemsList();
    const remote = this.activeRemote();
    const currentPath = this.activePath();

    // If no items are selected and we are in folder selection mode,
    // we use the current directory as the selection.
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
          meta: {
            remote: remote.name,
            isLocal: remote.isLocal,
            remoteType: remote.type,
          },
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

  onClose(): void {
    this.nautilusService.closeFilePicker(null);
  }

  toggleStar(item: FileBrowserItem): void {
    this.nautilusService.toggleItem('starred', item);
  }

  isStarred(item: FileBrowserItem): boolean {
    const remote = item.meta.remote || this.nautilusRemote()?.name;
    if (!remote) return false;
    return this.nautilusService.isSaved('starred', remote, item.entry.Path);
  }

  updateSelectionSummary(): void {
    const selectedPaths = this.selectedItems();
    const count = selectedPaths.size;

    if (count === 0) {
      this.selectionSummary.set('');
      return;
    }

    const allFiles = this.files();
    const selectedItems = allFiles.filter(item => selectedPaths.has(this.getItemKey(item)));

    if (count === 1) {
      const item = selectedItems[0];
      if (item) {
        if (item.entry.IsDir) {
          this.selectionSummary.set(
            `"${item.entry.Name}" ${this.translate.instant('nautilus.selection.selected')}`
          );
        } else {
          const fileSize = new FormatFileSizePipe().transform(item.entry.Size);
          this.selectionSummary.set(
            `"${item.entry.Name}" ${this.translate.instant('nautilus.selection.selected')} (${fileSize})`
          );
        }
      }
      return;
    }

    const folders = selectedItems.filter(item => item.entry.IsDir);
    const files = selectedItems.filter(item => !item.entry.IsDir);

    const folderCount = folders.length;
    const fileCount = files.length;

    const summaryParts: string[] = [];

    if (folderCount > 0) {
      const folderLabel = this.translate.instant(
        folderCount > 1 ? 'nautilus.selection.folders' : 'nautilus.selection.folder'
      );
      summaryParts.push(
        `${folderCount} ${folderLabel} ${this.translate.instant('nautilus.selection.selected')}`
      );
    }

    if (fileCount > 0) {
      const totalFileSize = files.reduce((sum, f) => sum + f.entry.Size, 0);
      const formattedSize = new FormatFileSizePipe().transform(totalFileSize);
      const itemLabel = this.translate.instant(
        folderCount > 0
          ? 'nautilus.selection.otherItems'
          : fileCount > 1
            ? 'nautilus.selection.items'
            : 'nautilus.selection.item'
      );
      summaryParts.push(
        `${fileCount} ${itemLabel} ${this.translate.instant('nautilus.selection.selected')} (${formattedSize})`
      );
    }

    this.selectionSummary.set(summaryParts.join(', '));
  }

  private syncSelection(newSelection: Set<string>): void {
    const pIdx = this.activePaneIndex();
    if (pIdx === 0) {
      this.selectedItems.set(newSelection);
    } else {
      this.selectedItemsRight.set(newSelection);
    }

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
    this.updateSelectionSummary();
  }

  isItemSelectable(item: Entry): boolean {
    if (!this.isPickerMode()) return true;
    const opts = this.pickerOptions();
    if (opts.selection === 'folders' && !item.IsDir) return false;
    if (opts.selection === 'files' && item.IsDir) return false;
    if (!item.IsDir && opts.allowedExtensions && opts.allowedExtensions.length) {
      const name = item.Name.toLowerCase();
      const ok = opts.allowedExtensions.some((ext: string) => name.endsWith(ext.toLowerCase()));
      if (!ok) return false;
    }
    return true;
  }

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
    const nextIdx = Math.max(0, Math.min(sizes.length - 1, idx + direction));
    this.iconSize.set(sizes[nextIdx]);
    this.saveIconSize();
  }

  increaseIconDisabled(): boolean {
    return this.iconSize() >= this.currentIconSizes().slice(-1)[0];
  }
  decreaseIconDisabled(): boolean {
    return this.iconSize() <= this.currentIconSizes()[0];
  }

  saveIconSize(): void {
    const key = this.layout() === 'list' ? 'list_icon_size' : 'grid_icon_size';
    const newSize = this.iconSize();
    if (this.layout() === 'list') this.savedListIconSize.set(newSize);
    else this.savedGridIconSize.set(newSize);
    this.appSettingsService.saveSetting('nautilus', key, newSize);
  }

  setLayout(l: 'grid' | 'list'): void {
    // Save current icon size before switching
    this.saveIconSize();

    this.layout.set(l);
    this.appSettingsService.saveSetting('nautilus', 'default_layout', l);

    // Restore saved size for the new layout, or use center value
    const savedSize = l === 'grid' ? this.savedGridIconSize() : this.savedListIconSize();
    if (savedSize) {
      this.iconSize.set(savedSize);
    } else {
      const sizes = l === 'grid' ? this.GRID_ICON_SIZES : this.LIST_ICON_SIZES;
      const centerIndex = Math.floor(sizes.length / 2);
      this.iconSize.set(sizes[centerIndex]);
    }
  }

  setSort(k: string): void {
    this.sortKey.set(k);
    this.appSettingsService.saveSetting('nautilus', 'sort_key', k);
    this.refresh();
  }

  toggleSort(column: string): void {
    const [currentCol, currentDir] = this.sortKey().split('-');
    const newDir =
      currentCol === column && currentDir === 'asc'
        ? 'desc'
        : currentCol === column
          ? 'asc'
          : column === 'size' || column === 'modified'
            ? 'desc'
            : 'asc';
    this.setSort(`${column}-${newDir}`);
  }

  toggleShowHidden(v: boolean): void {
    this.showHidden.set(v);
    this.appSettingsService.saveSetting('nautilus', 'show_hidden_items', v);
  }

  selectStarred(): void {
    if (this.activeStarredMode()) return;

    // We update the active pane to Starred
    if (this.activePaneIndex() === 0) {
      this.nautilusRemote.set(null);
      this.currentPath.set('');
      this.selectedItems.set(new Set());
      this.errorState.set(null);
    } else {
      this.nautilusRemoteRight.set(null);
      this.currentPathRight.set('');
      this.selectedItemsRight.set(new Set());
      this.errorStateRight.set(null);
    }

    this.updateSelectionSummary();
    // Update the active tab to reflect that we're in Starred view
    this._navigate(null, '', true);
  }

  openStarredInNewTab(): void {
    this.createTab(null, '');
  }

  clearSelection(): void {
    this.syncSelection(new Set());
  }

  cancelLoad(paneIndex = 0): void {
    if (paneIndex === 0) {
      this.isLoading.set(false);
    } else {
      this.isLoadingRight.set(false);
    }

    this.stopActiveListingJob(paneIndex);
  }

  private stopActiveListingJob(paneIndex: number): void {
    console.log('Needs cancel listing job for pane', paneIndex);
  }

  selectAll(): void {
    const allKeys = new Set(this.files().map(f => this.getItemKey(f)));
    this.syncSelection(allKeys);
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
    const newMode = !this.isSearchMode();
    this.isSearchMode.set(newMode);
    this.searchFilter.set('');
  }

  private subscribeToSettings(): void {
    combineLatest([
      this.appSettingsService.selectSetting('nautilus.default_layout'),
      this.appSettingsService.selectSetting('nautilus.sort_key'),
      this.appSettingsService.selectSetting('nautilus.show_hidden_items'),
      this.appSettingsService.selectSetting('nautilus.grid_icon_size'),
      this.appSettingsService.selectSetting('nautilus.list_icon_size'),
    ])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([layout, sortKey, showHidden, gridIconSize, listIconSize]) => {
        if (layout?.value && layout.value !== this.layout()) {
          this.layout.set(layout.value);
        }
        if (sortKey?.value && sortKey.value !== this.sortKey()) {
          this.sortKey.set(sortKey.value);
        }
        if (showHidden?.value !== undefined && showHidden.value !== this.showHidden()) {
          this.showHidden.set(showHidden.value);
        }

        if (gridIconSize?.value) this.savedGridIconSize.set(gridIconSize.value);
        if (listIconSize?.value) this.savedListIconSize.set(listIconSize.value);

        // Update current icon size if needed
        const currentLayout = this.layout();
        // If we just switched layout or sizes updated, re-evaluate
        const savedSize =
          currentLayout === 'grid' ? this.savedGridIconSize() : this.savedListIconSize();

        if (savedSize && savedSize !== this.iconSize()) {
          this.iconSize.set(savedSize);
        } else if (!savedSize) {
          // Fallback if no saved size yet
          const sizes = currentLayout === 'grid' ? this.GRID_ICON_SIZES : this.LIST_ICON_SIZES;
          const centerIndex = Math.floor(sizes.length / 2);
          if (this.iconSize() !== sizes[centerIndex]) {
            this.iconSize.set(sizes[centerIndex]);
          }
        }
      });
  }

  trackByFile(i: number, item: FileBrowserItem): string {
    return item.entry.ID || item.entry.Path;
  }
  trackByRemote(i: number, r: ExplorerRoot): string {
    return r.name;
  }
  trackBySortOption(i: number, o: { key: string }): string {
    return o.key;
  }
  trackByTab(i: number, t: { id: number }): number {
    return t.id;
  }
  trackByBookmark(i: number, b: FileBrowserItem): string {
    return (b.meta.remote || '') + b.entry.Path;
  }

  private _globalEscapeHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (this.isPickerMode()) {
        this.onClose();
      }
    }
  };

  @HostListener('window:keydown', ['$event'])
  public async handleKeyDown(event: KeyboardEvent): Promise<void> {
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

    if (event.key === 'Enter' && !isAlt && !isCtrl) {
      const selected = this.getSelectedItemsList();
      if (selected.length === 1) {
        event.preventDefault();
        this.navigateTo(selected[0]);
        return true;
      }
    }

    // Tabs
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

  @HostListener('window:resize') onResize(): void {
    const wasMobile = this.isMobile();
    const nowMobile = window.innerWidth < 680;
    this.isMobile.set(nowMobile);
    if (wasMobile !== nowMobile) {
      this.isSidenavOpen.set(!nowMobile);
    }
  }
}

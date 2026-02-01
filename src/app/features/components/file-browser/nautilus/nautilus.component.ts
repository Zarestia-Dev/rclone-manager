import {
  Component,
  EventEmitter,
  inject,
  Output,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  signal,
  computed,
  HostListener,
  effect,
  untracked,
  DestroyRef,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toSignal, toObservable, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { combineLatest, firstValueFrom, from, of } from 'rxjs';
import { catchError, finalize, map, switchMap } from 'rxjs/operators';
import { NgTemplateOutlet } from '@angular/common';

// Material Modules
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenav, MatSidenavModule } from '@angular/material/sidenav';
import { MatButtonModule } from '@angular/material/button';
import { MatGridListModule } from '@angular/material/grid-list';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDividerModule } from '@angular/material/divider';
import { MatDialog } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTableModule } from '@angular/material/table';

// CDK
import { DragDropModule, CdkDragDrop, CdkDrag, CdkDropList } from '@angular/cdk/drag-drop';
import { CdkMenuModule } from '@angular/cdk/menu';
import { ScrollingModule } from '@angular/cdk/scrolling';

// Services & Types
import {
  NautilusService,
  RemoteManagementService,
  AppSettingsService,
  PathSelectionService,
} from '@app/services';
import {
  Entry,
  ExplorerRoot,
  STANDARD_MODAL_SIZE,
  FileBrowserItem,
  FilePickerConfig,
  FsInfo,
} from '@app/types';

import { FormatFileSizePipe } from '@app/pipes';
import { IconService } from '@app/services';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';

import { InputModalComponent } from 'src/app/shared/modals/input-modal/input-modal.component';
import { NotificationService } from '@app/services';
import { RemoteAboutModalComponent } from '../../../modals/remote/remote-about-modal.component';
import { PropertiesModalComponent } from '../../../modals/properties/properties-modal.component';
import { OperationsPanelComponent } from '../operations-panel/operations-panel.component';

// --- Interfaces ---
interface Tab {
  id: number;
  title: string;
  remote: ExplorerRoot | null;
  path: string;
  selection: Set<string>;
  history: { remote: ExplorerRoot | null; path: string }[];
  historyIndex: number;
}

@Component({
  selector: 'app-nautilus',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    DragDropModule,
    CdkMenuModule,
    ScrollingModule,
    MatListModule,
    MatIconModule,
    MatToolbarModule,
    MatSidenavModule,
    MatButtonModule,
    MatGridListModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatDividerModule,
    MatProgressSpinnerModule,
    MatRadioModule,
    MatCheckboxModule,
    MatTableModule,
    FormatFileSizePipe,
    FormatFileSizePipe,
    OperationsPanelComponent,
    TranslateModule,
  ],
  templateUrl: './nautilus.component.html',
  styleUrl: './nautilus.component.scss',
})
export class NautilusComponent implements OnInit, OnDestroy {
  // --- Services ---
  private readonly nautilusService = inject(NautilusService);
  private readonly remoteManagement = inject(RemoteManagementService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly dialog = inject(MatDialog);
  private readonly notificationService = inject(NotificationService);
  private readonly appSettingsService = inject(AppSettingsService);
  public readonly iconService = inject(IconService);
  public readonly fileViewerService = inject(FileViewerService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly translate = inject(TranslateService);

  // --- Outputs ---
  @Output() closeOverlay = new EventEmitter<void>();

  // --- View Children ---
  @ViewChild('sidenav') sidenav!: MatSidenav;
  @ViewChild('pathInput') pathInput?: ElementRef<HTMLInputElement>;
  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;
  @ViewChild('pathScrollView') pathScrollView?: ElementRef<HTMLDivElement>;

  // --- UI State ---
  public readonly isLoading = signal(false);
  public readonly title = computed(() => {
    const state = this.filePickerState();
    const opts = state.options;
    if (state.isOpen && opts?.selection === 'folders') return 'nautilus.titles.selectFolder';
    if (state.isOpen && opts?.selection === 'files') return 'nautilus.titles.selectFile';
    if (state.isOpen) return 'nautilus.titles.selectItems';
    return 'nautilus.titles.files';
  });
  public readonly isMobile = signal(window.innerWidth < 680);
  public readonly isSidenavOpen = signal(true);
  public readonly sidenavMode = computed(() => (this.isMobile() ? 'over' : 'side'));
  public readonly errorState = signal<string | null>(null);
  private readonly initialLocationApplied = signal(false);

  // --- Picker State ---
  private readonly filePickerState = toSignal(this.nautilusService.filePickerState$, {
    initialValue: { isOpen: false, options: undefined },
  });
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
  public readonly starredMode = signal(false);

  private readonly savedGridIconSize = signal<number | null>(null);
  private readonly savedListIconSize = signal<number | null>(null);

  private readonly LIST_ICON_SIZES = [24, 40, 64];
  private readonly GRID_ICON_SIZES = [40, 50, 72, 120, 240];
  // Initial value will be set properly in loadSettings based on the loaded layout
  public readonly iconSize = signal(72);

  // Computed: Current icon sizes based on layout
  private readonly currentIconSizes = computed(() =>
    this.layout() === 'list' ? this.LIST_ICON_SIZES : this.GRID_ICON_SIZES
  );

  // --- Table Columns ---
  public readonly displayedColumns = ['name', 'size', 'modified', 'star'];

  // --- Selection ---
  public readonly selectedItems = signal<Set<string>>(new Set());
  public readonly selectionSummary = signal('');
  private lastSelectedIndex: number | null = null;

  // --- Navigation State ---
  public readonly nautilusRemote = signal<ExplorerRoot | null>(null);
  public readonly currentPath = signal<string>('');
  private readonly refreshTrigger = signal(0);

  public readonly pathSegments = computed(() => {
    const path = this.currentPath();
    return path ? path.split('/').filter(p => p) : [];
  });

  public readonly isEditingPath = signal(false);
  public readonly isSearchMode = signal(false);
  public readonly searchFilter = signal('');

  // --- Tabs System ---
  private interfaceTabCounter = 0;
  public readonly tabs = signal<Tab[]>([]);
  public readonly activeTabIndex = signal(0);
  public readonly canGoBack = computed(() => {
    const tab = this.tabs()[this.activeTabIndex()];
    return tab ? tab.historyIndex > 0 : false;
  });
  public readonly canGoForward = computed(() => {
    const tab = this.tabs()[this.activeTabIndex()];
    return tab ? tab.historyIndex < tab.history.length - 1 : false;
  });

  // --- Data ---
  public readonly bookmarks = this.nautilusService.bookmarks; // Direct signal
  public readonly cleanupSupportCache = signal<Record<string, boolean>>({});
  public readonly publicLinkSupportCache = signal<Record<string, boolean>>({});
  /** Cache of full FsInfo per remote (for hashes, features, etc.) */
  public readonly fsInfoCache = signal<Record<string, FsInfo | null>>({});

  // Filtered bookmarks based on picker mode
  public readonly filteredBookmarks = computed(() => {
    let marks = this.bookmarks();
    if (this.isPickerMode()) {
      const cfg = this.pickerOptions();
      marks = marks.filter(b => {
        if (cfg.mode === 'local' && !b.meta.isLocal) return false;
        if (cfg.mode === 'remote' && b.meta.isLocal) return false;
        if (cfg.allowedRemotes && !b.meta.isLocal) {
          return cfg.allowedRemotes.includes((b.meta.remote || '').replace(/:$/, ''));
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
    if (this.starredMode()) return '';
    const remote = this.nautilusRemote();
    const path = this.currentPath();
    if (!remote) return path;
    if (remote.isLocal) {
      const separator = remote.name.endsWith('/') ? '' : '/';
      return path ? `${remote.name}${separator}${path}` : remote.name;
    }
    const prefix = remote.name.includes(':') ? remote.name : `${remote.name}:`;
    const cleanPath = path.startsWith('/') ? path.substring(1) : path;
    return path ? `${prefix}${cleanPath}` : prefix;
  });

  public readonly sideRemoteSupportsCleanup = computed(() => {
    const r = this.sideContextRemote();
    return r ? (this.cleanupSupportCache()[r.name] ?? false) : false;
  });

  // --- File Data Pipeline ---
  private readonly rawFiles = toSignal(
    combineLatest([
      toObservable(this.nautilusRemote),
      toObservable(this.currentPath),
      toObservable(this.refreshTrigger),
    ]).pipe(
      switchMap(([remote, path]) => {
        if (!remote) return of([]);
        this.isLoading.set(true);
        let fsName = remote.name;
        if (!remote.isLocal) {
          fsName = this.pathSelectionService.normalizeRemoteForRclone(remote.name);
        }
        this.errorState.set(null);
        return from(this.remoteManagement.getRemotePaths(fsName, path, {})).pipe(
          map(res => {
            const list = res.list || [];
            // Hydrate items with context
            return list.map(
              f =>
                ({
                  entry: f,
                  meta: {
                    remote: fsName,
                    isLocal: remote.isLocal,
                    remoteType: remote.type,
                  },
                }) as FileBrowserItem
            );
          }),
          catchError(err => {
            console.error('Error fetching files:', err);
            this.errorState.set(err || this.translate.instant('nautilus.errors.loadFailed'));
            this.notificationService.showError(
              this.translate.instant('nautilus.errors.loadFailed')
            );
            return of([]);
          }),
          finalize(() => this.isLoading.set(false))
        );
      })
    ),
    { initialValue: [] as FileBrowserItem[] }
  );

  // 1. Source files (raw or starred)
  private readonly sourceFiles = computed(() => {
    if (this.starredMode()) {
      let items = this.nautilusService.starredItems();
      if (this.isPickerMode()) {
        const cfg = this.pickerOptions();
        items = items.filter(i => {
          if (cfg.mode === 'local' && !i.meta.isLocal) return false;
          if (cfg.mode === 'remote' && i.meta.isLocal) return false;
          if (cfg.allowedRemotes && !i.meta.isLocal) {
            return cfg.allowedRemotes.includes((i.meta.remote || '').replace(/:$/, ''));
          }
          return true;
        });
      }
      return items;
    }
    return this.rawFiles();
  });

  // 2. Filtered files (hidden files + search)
  private readonly filteredFiles = computed(() => {
    let files = this.sourceFiles();

    // Apply hidden files filter
    if (!this.showHidden() && !this.starredMode()) {
      files = files.filter(f => !f.entry.Name.startsWith('.'));
    }

    // Apply search filter
    const search = this.searchFilter().toLowerCase().trim();
    if (search) {
      files = files.filter(f => f.entry.Name.toLowerCase().includes(search));
    }

    return files;
  });

  // 3. Final sorted files
  public readonly files = computed(() => {
    const files = [...this.filteredFiles()];
    const [key, dir] = this.sortKey().split('-');
    const multiplier = dir === 'asc' ? 1 : -1;

    return files.sort((a, b) => {
      // Folders first
      if (a.entry.IsDir !== b.entry.IsDir) return a.entry.IsDir ? -1 : 1;

      switch (key) {
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
  });

  // --- Context Menu State ---
  public contextMenuItem: FileBrowserItem | null = null;
  public readonly sideContextRemote = signal<ExplorerRoot | null>(null);
  public bookmarkContextItem: FileBrowserItem | null = null;

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
    this.setupEffects();
    this.subscribeToSettings();
  }

  async ngOnInit(): Promise<void> {
    await this.setupInitialTab();
    this.setupEventListeners();
  }

  ngOnDestroy(): void {
    this.removeEventListeners();
  }

  private setupEffects(): void {
    effect(() => {
      this.pathSegments();
      setTimeout(() => {
        if (this.pathScrollView?.nativeElement) {
          const el = this.pathScrollView.nativeElement;
          el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
        }
      }, 50);
    });

    effect(() => {
      if (this.isEditingPath()) {
        setTimeout(() => this.pathInput?.nativeElement?.select(), 10);
      }
    });

    effect(() => {
      if (this.isSearchMode()) {
        setTimeout(() => {
          this.searchInput?.nativeElement?.focus();
          this.searchInput?.nativeElement?.select();
        }, 10);
      }
    });

    effect(() => {
      const remotes = this.allRemotesLookup();
      const cache = untracked(this.cleanupSupportCache);
      const missing = remotes.filter(r => cache[r.name] === undefined && !r.isLocal);
      if (missing.length > 0) {
        this.runBackgroundFsInfoChecks(missing);
      }
    });

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
    // 1. Ensure data is loaded from the service
    await this.nautilusService.loadRemoteData();

    const pickerState = this.filePickerState();
    let initialRemote: ExplorerRoot | null = null;
    let initialPath = '';

    // 2. Check if we're in picker mode with an initial location
    if (pickerState.isOpen && pickerState.options?.initialLocation) {
      const loc = pickerState.options.initialLocation;
      const cfg = pickerState.options;

      if (this.isDataReadyForConfig(cfg) && this.isLocationAllowedByConfig(loc, cfg)) {
        const parsed = this.parseLocationToRemoteAndPath(loc);
        if (parsed) {
          initialRemote = parsed.remote;
          initialPath = parsed.path;
          this.initialLocationApplied.set(true);
        }
      }
    }

    // 3. If no initialLocation handled, check for requested path (e.g. from Debug menu)
    if (!initialRemote) {
      const targetPath = this.nautilusService.targetPath();
      if (targetPath) {
        const parsed = this.parseLocationToRemoteAndPath(targetPath);
        if (parsed) {
          initialRemote = parsed.remote;
          initialPath = parsed.path;
        } else {
          // If we can't parse it (e.g. no remote matched), try to find a default local drive and use path relative to it?
          // Or just open local drive root.
          // Assuming parseLocationToRemoteAndPath handles usage of "C:/" or "/" roots correctly which should cover most cases.
        }
        this.nautilusService.targetPath.set(null);
      }
    }

    // 4. If still no remote, check for requested remote (e.g. from Tray)
    if (!initialRemote) {
      const requestedName = this.nautilusService.selectedNautilusRemote();
      if (requestedName) {
        initialRemote = this.allRemotesLookup().find(r => r.name === requestedName) || null;
        this.nautilusService.selectedNautilusRemote.set(null);
      }
    }

    // 4. For picker mode without initial location, use appropriate default
    if (!initialRemote && pickerState.isOpen && pickerState.options) {
      const cfg = pickerState.options;
      if (cfg.mode === 'remote') {
        let remotes = this.cloudRemotes();
        if (cfg.allowedRemotes && cfg.allowedRemotes.length) {
          remotes = remotes.filter(r => cfg.allowedRemotes?.includes(r.name));
        }
        initialRemote = remotes[0] || null;
      } else if (cfg.mode === 'local') {
        initialRemote = this.nautilusService.localDrives()[0] || null;
      } else {
        initialRemote = this.nautilusService.localDrives()[0] || null;
      }
    }

    // 5. Fallback: Open first local drive
    if (!initialRemote) {
      initialRemote = this.nautilusService.localDrives()[0] || null;
    }

    // 6. Create the tab with the correct remote and path directly
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
      const remote = loc.split(':')[0];
      if (cfg.allowedRemotes && cfg.allowedRemotes.length) {
        return cfg.allowedRemotes.includes(remote);
      }
      return true;
    }
    // mode === 'both'
    if (hasColon && cfg.allowedRemotes && cfg.allowedRemotes.length) {
      const remote = loc.split(':')[0];
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
          const r = cfg.initialLocation.split(':')[0];
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
  canDropOnStarred(item: CdkDrag<FileBrowserItem>, _drop: CdkDropList): boolean {
    const data = item.data;
    return !!(data?.entry && data.entry.Path);
  }

  canDropOnBookmarks(item: CdkDrag<FileBrowserItem>, _drop: CdkDropList): boolean {
    const data = item.data;
    return !!data?.entry?.IsDir;
  }

  onDropToStarred(event: CdkDragDrop<unknown[]>): void {
    const item = event.item.data as FileBrowserItem;
    if (!item) return;
    if (!this.isStarred(item)) {
      this.toggleStar(item);
      this.notificationService.openSnackBar(
        this.translate.instant('nautilus.notifications.addedToStarred', {
          item: item.entry.Name,
        }),
        this.translate.instant('nautilus.notifications.undo')
      );
    }
  }

  onDropToLocal(event: CdkDragDrop<FileBrowserItem[]>): void {
    if (event.previousContainer !== event.container) {
      const item = event.item.data as FileBrowserItem;
      if (!item || !item.entry.IsDir) return;
      this.addBookmark(item);
    }
  }

  // --- Bookmarks ---
  addBookmark(item: FileBrowserItem): void {
    this.nautilusService.toggleItem('bookmarks', item);
  }

  removeBookmark(bookmark: FileBrowserItem): void {
    this.nautilusService.toggleItem('bookmarks', bookmark);
  }

  openBookmark(bookmark: FileBrowserItem): void {
    const remoteDetails = this.allRemotesLookup().find(r => r.name === bookmark.meta.remote);
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
    this.starredMode.set(false);
    this._navigate(remote, '', true);
  }

  updatePath(newPath: string): void {
    this._navigate(this.nautilusRemote(), newPath, true);
  }

  navigateToSegment(index: number): void {
    const segments = this.pathSegments();
    const newPath = segments.slice(0, index + 1).join('/');
    this.updatePath(newPath);
  }

  navigateToPath(rawInput: string): void {
    this.isEditingPath.set(false);
    if (this.starredMode()) this.starredMode.set(false);

    // Try to parse as absolute path (remote or local)
    const parsed = this.parseLocationToRemoteAndPath(rawInput);
    if (parsed) {
      this._navigate(parsed.remote, parsed.path, true);
      return;
    }

    // Fallback: treat as relative path from current location
    const currentPath = this.currentPath();
    const normalized = rawInput.replace(/\\/g, '/');
    const newPath = currentPath ? `${currentPath}/${normalized}` : normalized;
    this.updatePath(newPath);
  }

  navigateTo(item: FileBrowserItem): void {
    if (item.entry.IsDir) {
      if (this.starredMode()) {
        // Resolve the remote from the item metadata when clicking from Starred list
        const remoteName = item.meta.remote.replace(/:$/, '');
        const remote = this.allRemotesLookup().find(r => r.name === remoteName);
        if (remote) {
          this.starredMode.set(false);
          this._navigate(remote, item.entry.Path, true);
        } else {
          this.notificationService.showError(
            this.translate.instant('nautilus.errors.remoteNotFound', { remote: remoteName })
          );
        }
      } else {
        this.updatePath(item.entry.Path);
      }
    } else {
      this.openFilePreview(item);
    }
  }

  private _navigate(remote: ExplorerRoot | null, path: string, newHistory: boolean): void {
    const currentTabs = this.tabs();
    const index = this.activeTabIndex();
    const tab = currentTabs[index];
    if (!tab) return;

    let updatedHistory = tab.history;
    let updatedHistoryIndex = tab.historyIndex;

    if (newHistory) {
      if (tab.historyIndex < tab.history.length - 1) {
        updatedHistory = tab.history.slice(0, tab.historyIndex + 1);
      }
      updatedHistory = [...updatedHistory, { remote, path }];
      updatedHistoryIndex = updatedHistory.length - 1;
    }

    const computedTitle =
      this.starredMode() && !remote
        ? 'nautilus.titles.starred'
        : path.split('/').pop() || remote?.label || 'nautilus.titles.files';
    const updatedTab: Tab = {
      ...tab,
      remote,
      path,
      title: computedTitle,
      selection: new Set<string>(),
      history: updatedHistory,
      historyIndex: updatedHistoryIndex,
    };

    this.tabs.update(tabs => tabs.map((t, i) => (i === index ? updatedTab : t)));
    this.nautilusRemote.set(remote);
    this.currentPath.set(path);
    this.selectedItems.set(updatedTab.selection);
    this.updateSelectionSummary();
  }

  // --- Tabs ---
  createTab(remote: ExplorerRoot | null, path = ''): void {
    const id = ++this.interfaceTabCounter;
    // Compute initial title: use path segment, remote label, 'Starred' if in starred mode, or 'Files'
    const initialTitle =
      path.split('/').pop() ||
      remote?.label ||
      (this.starredMode() && !remote ? 'Starred' : 'Files');
    const t = {
      id,
      title: initialTitle,
      remote,
      path,
      selection: new Set<string>(),
      history: [],
      historyIndex: -1,
    };
    this.tabs.update(list => [...list, t]);
    this.activeTabIndex.set(this.tabs().length - 1);
    this._navigate(remote, path, true);
  }

  closeTab(i: number): void {
    if (i < 0 || i >= this.tabs().length) return;
    this.tabs.update(list => list.filter((_, idx) => idx !== i));
    if (this.tabs().length === 0) {
      this.createTab(null, '');
      return;
    }
    let newIndex = this.activeTabIndex();
    if (i <= newIndex) newIndex = Math.max(0, newIndex - 1);
    this.switchTab(newIndex);
  }

  switchTab(i: number): void {
    if (i < 0 || i >= this.tabs().length) return;
    this.activeTabIndex.set(i);
    const t = this.tabs()[i];
    this._navigate(t.remote, t.path, false);
  }

  goBack(): void {
    const currentTabs = this.tabs();
    const index = this.activeTabIndex();
    const tab = currentTabs[index];
    if (tab && tab.historyIndex > 0) {
      const newHistoryIndex = tab.historyIndex - 1;
      const entry = tab.history[newHistoryIndex];
      const updatedTab: Tab = { ...tab, historyIndex: newHistoryIndex };
      this.tabs.update(tabs => tabs.map((t, i) => (i === index ? updatedTab : t)));
      this._navigate(entry.remote, entry.path, false);
    }
  }

  goForward(): void {
    const currentTabs = this.tabs();
    const index = this.activeTabIndex();
    const tab = currentTabs[index];
    if (tab && tab.historyIndex < tab.history.length - 1) {
      const newHistoryIndex = tab.historyIndex + 1;
      const entry = tab.history[newHistoryIndex];
      const updatedTab: Tab = { ...tab, historyIndex: newHistoryIndex };
      this.tabs.update(tabs => tabs.map((t, i) => (i === index ? updatedTab : t)));
      this._navigate(entry.remote, entry.path, false);
    }
  }

  // --- Interactions ---
  refresh(): void {
    this.refreshTrigger.update(v => v + 1);
  }

  onItemClick(item: FileBrowserItem, event: Event, index: number): void {
    event.stopPropagation();
    if (this.isPickerMode() && !this.isItemSelectable(item.entry)) return;

    const sel = new Set(this.selectedItems());
    const multi = !this.isPickerMode() || !!this.pickerOptions().multi;
    const e = event as MouseEvent | KeyboardEvent;

    if (e.shiftKey && this.lastSelectedIndex !== null && multi) {
      sel.clear();
      const start = Math.min(this.lastSelectedIndex, index);
      const end = Math.max(this.lastSelectedIndex, index);
      const files = this.files();
      for (let i = start; i <= end; i++) sel.add(files[i].entry.Path);
    } else if (e.ctrlKey && multi) {
      if (sel.has(item.entry.Path)) sel.delete(item.entry.Path);
      else sel.add(item.entry.Path);
      this.lastSelectedIndex = index;
    } else {
      sel.clear();
      sel.add(item.entry.Path);
      this.lastSelectedIndex = index;
    }

    this.syncSelection(sel);
  }

  setContextItem(item: FileBrowserItem | null): void {
    this.contextMenuItem = item;
  }

  openContextMenuOpen(): void {
    if (this.contextMenuItem) this.navigateTo(this.contextMenuItem);
  }

  openContextMenuOpenInNewTab(): void {
    const item = this.contextMenuItem;
    if (!item || !item.entry.IsDir) return;

    // Try to find remote context:
    // 1. Active remote in view
    let root = this.nautilusRemote();

    // 2. If in starred view (no active remote), infer from item meta
    if (!root && item.meta.remote) {
      const remoteName = item.meta.remote.replace(/:$/, '');
      root =
        this.allRemotesLookup().find(
          r =>
            r.name === remoteName ||
            this.pathSelectionService.normalizeRemoteName(r.name) === remoteName
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
    if (!this.contextMenuItem) return;
    const remote = this.nautilusRemote();
    const prefix = remote?.name;
    // Use meta.remote if available (for starred items)
    const remoteName = this.contextMenuItem.meta.remote || prefix;
    const sep = !this.contextMenuItem.meta.isLocal || !remote?.isLocal ? ':' : '/';

    // Ensure clean path construction
    const cleanRemote = remoteName?.endsWith(':') ? remoteName : `${remoteName}${sep}`;
    // Local paths usually don't want double slashes if remoteName is just "/"
    const full = `${cleanRemote}${this.contextMenuItem.entry.Path}`.replace('//', '/');

    navigator.clipboard?.writeText(full);
  }

  openContextMenuSelectToggle(): void {
    if (this.contextMenuItem) {
      const sel = new Set(this.selectedItems());
      const path = this.contextMenuItem.entry.Path;
      if (sel.has(path)) sel.delete(path);
      else sel.add(path);
      this.syncSelection(sel);
    }
  }

  openPropertiesDialog(source: 'contextMenu' | 'bookmark'): void {
    const currentRemote = this.nautilusRemote();
    const item = source === 'bookmark' ? this.bookmarkContextItem : this.contextMenuItem;

    // For bookmark, require item; for context menu, fallback to current path
    if (source === 'bookmark' && !item) return;

    const path = item?.entry.Path || this.currentPath();
    const isLocal = item?.meta.isLocal ?? currentRemote?.isLocal ?? true;

    // Normalize remote name for API calls
    let remoteName = item?.meta.remote || currentRemote?.name;
    if (remoteName && !isLocal) {
      remoteName = this.pathSelectionService.normalizeRemoteForRclone(remoteName);
    }

    // Get cached fsInfo for this remote
    const baseName = (item?.meta.remote || currentRemote?.name || '').replace(/:$/, '');
    const cachedFsInfo = this.fsInfoCache()[baseName] || null;

    this.dialog.open(PropertiesModalComponent, {
      data: {
        remoteName: remoteName,
        path: path,
        isLocal: isLocal,
        item: item?.entry,
        remoteType: item?.meta.remoteType || currentRemote?.type,
        fsInfo: cachedFsInfo,
      },
      height: '60vh',
      maxHeight: '800px',
      width: '60vw',
      maxWidth: '400px',
    });
  }

  async openContextMenuNewFolder(): Promise<void> {
    const remote = this.nautilusRemote();
    if (!remote) return;

    const normalized = !remote.isLocal
      ? this.pathSelectionService.normalizeRemoteForRclone(remote.name)
      : remote.name;

    const ref = this.dialog.open(InputModalComponent, {
      data: {
        title: this.translate.instant('nautilus.modals.newFolder.title'),
        label: this.translate.instant('nautilus.modals.newFolder.label'),
        icon: 'folder',
        placeholder: this.translate.instant('nautilus.modals.newFolder.placeholder'),
        existingNames: (this.files() || []).map(f => f.entry.Name),
      },
      disableClose: true,
    });

    try {
      const folderName = await firstValueFrom(ref.afterClosed());
      if (!folderName) return;
      const current = this.currentPath();
      const sep = remote.isLocal && (current === '' || current.endsWith('/')) ? '' : '/';
      const newPath = current ? `${current}${sep}${folderName}` : folderName;
      await this.remoteManagement.makeDirectory(normalized, newPath);
      this.refresh();
    } catch {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.createFolderFailed')
      );
    }
  }

  async openRemoteAboutFromSidebar(): Promise<void> {
    const r = this.sideContextRemote();
    if (!r) return;
    const normalized = !r.isLocal
      ? this.pathSelectionService.normalizeRemoteForRclone(r.name)
      : r.name;
    this.dialog.open(RemoteAboutModalComponent, {
      data: { remote: { displayName: r.name, normalizedName: normalized, type: r.type } },
      ...STANDARD_MODAL_SIZE,
    });
  }

  async openSidebarCleanup(): Promise<void> {
    const r = this.sideContextRemote();
    if (!r) return;
    const confirmed = await this.notificationService.confirmModal(
      this.translate.instant('nautilus.modals.emptyTrash.title'),
      this.translate.instant('nautilus.modals.emptyTrash.message', { remote: r.name })
    );
    if (!confirmed) return;
    try {
      const normalized = !r.isLocal
        ? this.pathSelectionService.normalizeRemoteForRclone(r.name)
        : r.name;
      await this.remoteManagement.cleanup(normalized);
      this.notificationService.showSuccess(
        this.translate.instant('nautilus.notifications.trashEmptied')
      );
    } catch (e) {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.emptyTrashFailed', { error: (e as Error).message })
      );
    }
  }

  deleteContextBookmark(): void {
    if (this.bookmarkContextItem) {
      this.removeBookmark(this.bookmarkContextItem);
    }
  }

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

  async openFilePreview(item: FileBrowserItem): Promise<void> {
    const currentRemote = this.nautilusRemote();
    const actualRemoteName = item.meta.remote || currentRemote?.name;

    if (!actualRemoteName) {
      this.notificationService.showError(this.translate.instant('nautilus.errors.openFileFailed'));
      return;
    }

    // Get isLocal from fsInfoCache (rclone's fsinfo.Features.IsLocal) with fallback
    const baseName = actualRemoteName.replace(/:$/, '');
    const cachedFsInfo = this.fsInfoCache()[baseName];
    const isLocal = cachedFsInfo?.Features?.IsLocal ?? currentRemote?.isLocal ?? false;

    // Pass Entry[] to the viewer
    const entries = this.files().map(f => f.entry);
    const idx = this.files().findIndex(f => f.entry.Path === item.entry.Path);
    this.fileViewerService.open(entries, idx, actualRemoteName, isLocal);
  }

  confirmSelection(): void {
    let paths = Array.from(this.selectedItems());
    const remote = this.nautilusRemote();
    if (paths.length === 0 && this.pickerOptions().selection === 'folders') {
      paths = [this.currentPath()];
    }
    const minSel = this.pickerOptions().minSelection ?? 0;
    const prefix = !remote?.isLocal
      ? this.pathSelectionService.normalizeRemoteForRclone(remote?.name ?? '')
      : remote?.name;

    const fullPaths = paths.map(p => {
      if (remote?.isLocal) {
        const sep = prefix?.endsWith('/') ? '' : '/';
        return `${prefix}${sep}${p}`;
      }
      return `${prefix}${p}`;
    });

    if (this.isPickerMode() && fullPaths.length < minSel) {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.minSelection', {
          min: minSel,
          s: minSel > 1 ? 's' : '',
        })
      );
      return;
    }
    this.nautilusService.closeFilePicker(fullPaths);
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
    const selectedItems = allFiles.filter(item => selectedPaths.has(item.entry.Path));

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
    this.selectedItems.set(newSelection);
    this.tabs.update(tabs =>
      tabs.map((tab, i) =>
        i === this.activeTabIndex() ? { ...tab, selection: newSelection } : tab
      )
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
    if (this.starredMode()) return;
    this.starredMode.set(true);
    this.nautilusRemote.set(null);
    this.currentPath.set('');
    this.selectedItems.set(new Set());
    this.errorState.set(null);
    this.updateSelectionSummary();
    // Update the active tab to reflect that we're in Starred view
    this._navigate(null, '', true);
  }

  openStarredInNewTab(): void {
    // Ensure the app is in starred mode before creating the new tab so the title and
    // navigation reflect Starred properly.
    if (!this.starredMode()) this.starredMode.set(true);
    this.createTab(null, '');
  }

  onPathScroll(e: WheelEvent): void {
    (e.currentTarget as HTMLElement).scrollBy(e.deltaY, 0);
  }

  clearSelection(): void {
    this.syncSelection(new Set());
  }

  cancelLoad(): void {
    this.isLoading.set(false);
  }

  selectAll(): void {
    const allPaths = new Set(this.files().map(f => f.entry.Path));
    this.syncSelection(allPaths);
  }

  copyCurrentLocation(): void {
    const path = this.fullPathInput();
    if (path) {
      navigator.clipboard?.writeText(path);
      this.notificationService.openSnackBar(
        this.translate.instant('nautilus.notifications.locationCopied'),
        this.translate.instant('common.close')
      );
    }
  }

  toggleSearchMode(): void {
    const newMode = !this.isSearchMode();
    this.isSearchMode.set(newMode);
    if (!newMode) {
      this.searchFilter.set('');
    }
  }

  async runBackgroundFsInfoChecks(remotes: ExplorerRoot[]): Promise<void> {
    // Initialize caches for new remotes
    this.cleanupSupportCache.update(c => {
      const u: Record<string, boolean> = {};
      remotes.forEach(r => (u[r.name] = false));
      return { ...c, ...u };
    });

    for (const r of remotes) {
      if (r.isLocal) continue;
      try {
        const normalized = this.pathSelectionService.normalizeRemoteForRclone(r.name);
        const info = (await this.remoteManagement
          .getFsInfo(normalized)
          .catch(() => null)) as FsInfo | null;

        // Cache the full FsInfo
        this.fsInfoCache.update(c => ({ ...c, [r.name]: info }));

        // Also update feature-specific caches for convenience
        if (info?.Features?.['CleanUp']) {
          this.cleanupSupportCache.update(c => ({ ...c, [r.name]: true }));
        }
        if (info?.Features?.['PublicLink']) {
          this.publicLinkSupportCache.update(c => ({ ...c, [r.name]: true }));
        }
      } catch {
        console.error('Failed to check remote features');
      }
    }
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

  @HostListener('window:resize') onResize(): void {
    this.isMobile.set(window.innerWidth < 680);
    // Ensure sidebar opens when switching to desktop mode
    if (!this.isMobile()) {
      this.isSidenavOpen.set(true);
    }
  }
}

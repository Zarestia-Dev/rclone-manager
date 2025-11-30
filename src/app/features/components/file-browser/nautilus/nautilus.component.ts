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
  ChangeDetectionStrategy,
} from '@angular/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { combineLatest, firstValueFrom, from, of } from 'rxjs';
import { catchError, finalize, map, switchMap, startWith, take } from 'rxjs/operators';
import { CommonModule } from '@angular/common';

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

// Services & Types
import {
  UiStateService,
  NautilusService,
  RemoteManagementService,
  MountManagementService,
  FilePickerOptions,
  PathSelectionService,
  AppSettingsService,
} from '@app/services';
import { StarredItem } from 'src/app/services/ui/nautilus.service';
import { Entry, ExplorerRoot, LocalDrive, STANDARD_MODAL_SIZE } from '@app/types';
import { FormatFileSizePipe } from '@app/pipes';
import { AnimationsService } from 'src/app/shared/services/animations.service';
import { IconService } from 'src/app/shared/services/icon.service';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import { FileBrowserItem } from '@app/types';

import { InputModalComponent } from 'src/app/shared/modals/input-modal/input-modal.component';
import { NotificationService } from 'src/app/shared/services/notification.service';
import { RemoteAboutModalComponent } from '../remote/remote-about-modal.component';
import { PropertiesModalComponent } from '../properties/properties-modal.component';

// --- Interfaces ---
interface FsInfo {
  Features?: {
    CleanUp?: boolean;
  };
}
interface Tab {
  id: number;
  title: string;
  remote: ExplorerRoot | null;
  path: string;
  selection: Set<string>;
  history: { remote: ExplorerRoot | null; path: string }[];
  historyIndex: number;
}

type SidebarLocalItem =
  | { kind: 'drive'; data: ExplorerRoot }
  | { kind: 'bookmark'; data: StarredItem };

@Component({
  selector: 'app-nautilus',
  standalone: true,
  imports: [
    CommonModule,
    DragDropModule,
    CdkMenuModule,
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
    // Pipes
    FormatFileSizePipe,
  ],
  templateUrl: './nautilus.component.html',
  styleUrl: './nautilus.component.scss',
  animations: [AnimationsService.slideOverlay()],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NautilusComponent implements OnInit, OnDestroy {
  // --- Services ---
  private readonly uiStateService = inject(UiStateService);
  private readonly nautilusService = inject(NautilusService);
  private readonly remoteManagement = inject(RemoteManagementService);
  private readonly mountManagement = inject(MountManagementService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly dialog = inject(MatDialog);
  private readonly notificationService = inject(NotificationService);
  private readonly appSettingsService = inject(AppSettingsService);
  public readonly iconService = inject(IconService);
  public readonly fileViewerService = inject(FileViewerService);

  // --- Outputs ---
  @Output() closeOverlay = new EventEmitter<void>();

  // --- View Children ---
  @ViewChild('sidenav') sidenav!: MatSidenav;
  @ViewChild('pathInput') pathInput?: ElementRef<HTMLInputElement>;
  @ViewChild('pathScrollView') pathScrollView?: ElementRef<HTMLDivElement>;

  // --- UI State ---
  public readonly isLoading = signal(false);
  public readonly title = computed(() => {
    const state = this.filePickerState();
    if (state.isOpen && state.options?.selectFolders) return 'Select Folder';
    if (state.isOpen) return 'Select Files';
    return 'Files';
  });
  public readonly isMobile = signal(window.innerWidth < 680);
  public readonly isSidenavOpen = signal(!this.isMobile());
  public readonly sidenavMode = computed(() => (this.isMobile() ? 'over' : 'side'));

  // --- Picker State (Computed from service) ---
  private readonly filePickerState = toSignal(this.nautilusService.filePickerState$, {
    initialValue: { isOpen: false, options: {} },
  });
  public readonly isPickerMode = computed(() => this.filePickerState().isOpen);
  public readonly pickerOptions = computed(
    (): FilePickerOptions => this.filePickerState().options || {}
  );

  // --- View Configuration ---
  public readonly layout = signal<'grid' | 'list'>('grid');
  public readonly sortKey = signal('name-asc');
  public readonly sortDirection = computed(() => (this.sortKey().endsWith('asc') ? 'asc' : 'desc'));
  public readonly showHidden = signal(false);
  public readonly starredMode = signal(false);

  private readonly LIST_ICON_SIZES = [24, 40, 64];
  private readonly GRID_ICON_SIZES = [40, 50, 72, 120, 240];
  public readonly iconSize = signal(this.GRID_ICON_SIZES[1]);

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

  // --- Data & Bookmarks ---
  public readonly bookmarks = this.nautilusService.getBookmarks();
  public readonly cleanupSupportCache = signal<Record<string, boolean>>({});

  // Raw Data Source (Combined)
  private readonly rawRemotesData = toSignal(
    combineLatest([
      this.remoteManagement.remotes$,
      this.mountManagement.mountedRemotes$,
      from(this.remoteManagement.getLocalDrives()),
      from(this.remoteManagement.getAllRemoteConfigs().catch(() => ({}))),
    ]),
    { initialValue: [[], [], [], {}] }
  );

  // Computed: Local Drives
  public readonly localDrives = computed<ExplorerRoot[]>(() => {
    const [, , localDrives] = this.rawRemotesData();
    return (localDrives || []).map((drive: LocalDrive) => ({
      name: drive.name,
      label: drive.label || drive.name,
      type: 'hard-drive',
      fs_type: 'local',
      isMounted: false,
    }));
  });

  // Computed: Cloud Remotes
  public readonly cloudRemotes = computed<ExplorerRoot[]>(() => {
    const [remoteNames, mountedRemotes, , configs] = this.rawRemotesData();
    return (remoteNames || []).map(name => {
      const mountedInfo = mountedRemotes.find(
        (mr: unknown) => (mr as { fs: string }).fs.replace(/:$/, '') === name
      );
      const config = (configs as Record<string, { type?: string; Type?: string } | undefined>)[
        name
      ];
      return {
        name,
        label: name,
        type: config?.type || config?.Type || 'cloud',
        fs_type: 'remote',
        isMounted: !!mountedInfo,
        mountPoint: mountedInfo?.mount_point,
      };
    });
  });

  // Computed: Sidebar Combined List
  public readonly sidebarLocalItems = computed<SidebarLocalItem[]>(() => {
    const drives = this.localDrives().map(d => ({ kind: 'drive', data: d }) as SidebarLocalItem);
    const marks = this.bookmarks().map(b => ({ kind: 'bookmark', data: b }) as SidebarLocalItem);
    return [...drives, ...marks];
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
    if (remote.fs_type === 'local') {
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
        if (remote.fs_type === 'remote') {
          fsName = this.pathSelectionService.normalizeRemoteForRclone(remote.name);
        }
        return from(this.remoteManagement.getRemotePaths(fsName, path, {})).pipe(
          map(res => {
            const list = res.list || [];
            // HYDRATE THE ITEMS WITH CONTEXT HERE
            return list.map(
              f =>
                ({
                  ...f,
                  _remote: fsName, // "gdrive:"
                  _fsType: remote.fs_type, // "remote"
                }) as FileBrowserItem
            );
          }),
          catchError(err => {
            console.error('Error fetching files:', err);
            this.notificationService.showError('Failed to load directory');
            return of([]);
          }),
          startWith([]),
          finalize(() => this.isLoading.set(false))
        );
      })
    ),
    { initialValue: [] as FileBrowserItem[] }
  );

  // 1. Source files (raw or starred)
  private readonly sourceFiles = computed(() => {
    if (this.starredMode()) {
      const list = this.nautilusService.starredItems();
      return list.map(s => ({ ...s.entry, _remote: s.remote, _fsType: 'remote' as const }));
    }
    return this.rawFiles();
  });

  // 2. Filtered files (hidden files)
  private readonly filteredFiles = computed(() => {
    const files = this.sourceFiles();
    if (this.showHidden() || this.starredMode()) return files;
    return files.filter(f => !f.Name.startsWith('.'));
  });

  // 3. Final sorted files
  public readonly files = computed(() => {
    const files = [...this.filteredFiles()];
    const [key, dir] = this.sortKey().split('-');
    const multiplier = dir === 'asc' ? 1 : -1;

    return files.sort((a, b) => {
      // Folders first
      if (a.IsDir !== b.IsDir) return a.IsDir ? -1 : 1;

      switch (key) {
        case 'name':
          return a.Name.localeCompare(b.Name, undefined, { numeric: true }) * multiplier;
        case 'size':
          return (a.Size - b.Size) * multiplier;
        case 'modified':
          return (new Date(a.ModTime).getTime() - new Date(b.ModTime).getTime()) * multiplier;
        default:
          return 0;
      }
    });
  });

  // --- Context Menu State ---
  public contextMenuItem: Entry | null = null;
  public readonly sideContextRemote = signal<ExplorerRoot | null>(null);
  public bookmarkContextItem: StarredItem | null = null;

  // --- Sort Options ---
  public readonly sortOptions = [
    { key: 'name-asc', label: 'A-Z' },
    { key: 'name-desc', label: 'Z-A' },
    { key: 'modified-desc', label: 'Last Modified' },
    { key: 'modified-asc', label: 'First Modified' },
    { key: 'size-desc', label: 'Size (Largest First)' },
    { key: 'size-asc', label: 'Size (Smallest First)' },
  ];

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  constructor() {
    this.setupEffects();
    this.loadSettings();
  }

  async ngOnInit(): Promise<void> {
    await this.initializeRemotes();
    this.setupEventListeners();
  }

  ngOnDestroy(): void {
    this.removeEventListeners();
  }

  // ==========================================================================
  // Initialization & Effects
  // ==========================================================================

  private setupEffects(): void {
    // Scroll
    effect(() => {
      this.pathSegments();
      setTimeout(() => {
        if (this.pathScrollView?.nativeElement) {
          const el = this.pathScrollView.nativeElement;
          el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
        }
      }, 50);
    });

    // Input Focus
    effect(() => {
      if (this.isEditingPath()) {
        setTimeout(() => this.pathInput?.nativeElement?.select(), 10);
      }
    });

    // Cleanup Capability Check
    effect(() => {
      const remotes = this.allRemotesLookup();
      const cache = untracked(this.cleanupSupportCache);
      const missing = remotes.filter(r => cache[r.name] === undefined && r.fs_type === 'remote');
      if (missing.length > 0) {
        this.runBackgroundCleanupChecks(missing);
      }
    });
  }

  private async initializeRemotes(): Promise<void> {
    try {
      await Promise.all([
        this.remoteManagement.getRemotes(),
        this.mountManagement.getMountedRemotes(),
      ]);

      this.uiStateService.selectedRemote$.pipe(take(1)).subscribe(async currentSelected => {
        let initial: ExplorerRoot | null = null;
        if (currentSelected) {
          initial = {
            name: currentSelected.remoteSpecs.name,
            label: currentSelected.remoteSpecs.name,
            type: currentSelected.remoteSpecs.type,
            fs_type: 'remote',
            isMounted: false,
          };
        } else {
          const drives = await this.remoteManagement.getLocalDrives();
          if (drives.length > 0) {
            initial = {
              name: drives[0].name,
              label: drives[0].label,
              type: 'hard-drive',
              fs_type: 'local',
              isMounted: false,
            };
          }
        }
        this.createTab(initial, '');
      });
    } catch (e) {
      console.warn('Init failed', e);
    }
  }

  private setupEventListeners(): void {
    window.addEventListener('keydown', this._globalEscapeHandler, true);
  }

  private removeEventListeners(): void {
    window.removeEventListener('keydown', this._globalEscapeHandler, true);
  }

  // ==========================================================================
  // Drag & Drop Logic
  // ==========================================================================

  /** Prevent items from being dropped/sorted into the file view */
  fileViewDropPredicate(_item: CdkDrag<unknown>, _drop: CdkDropList<unknown>): boolean {
    return false;
  }

  /** Allow dropping files/folders onto Starred */
  canDropOnStarred(item: CdkDrag<FileBrowserItem>, _drop: CdkDropList): boolean {
    const data = item.data;
    return !!(data && data.Path && data.Name);
  }

  /** Allow dropping folders or reordering bookmarks */
  canDropOnBookmarks(item: CdkDrag<FileBrowserItem | StarredItem>, _drop: CdkDropList): boolean {
    const data = item.data;
    if ('remote' in data && 'entry' in data) return true; // Reordering bookmark
    if ('IsDir' in data && data.IsDir) return true; // New Folder
    return false; // Reject files
  }

  onDropToStarred(event: CdkDragDrop<unknown[]>): void {
    const item = event.item.data as FileBrowserItem;
    if (!item) return;
    if (!this.isStarred(item)) {
      this.toggleStar(item);
      this.notificationService.openSnackBar(`'${item.Name}' added to Starred`, 'Undo');
    }
  }

  onDropToLocal(event: CdkDragDrop<StarredItem[]>): void {
    if (event.previousContainer === event.container) {
      // Reordering existing bookmarks
      const drivesCount = this.localDrives().length;
      const prevIndex = event.previousIndex - drivesCount;
      const currIndex = event.currentIndex - drivesCount;

      if (prevIndex >= 0 && currIndex >= 0 && prevIndex < this.bookmarks().length) {
        this.nautilusService.reorderBookmarks(prevIndex, currIndex);
      }
    } else {
      // Create new bookmark
      const item = event.item.data as FileBrowserItem;
      if (!item || !item.IsDir) return;
      this.addBookmark(item);
    }
  }

  // ==========================================================================
  // Bookmarks Logic
  // ==========================================================================

  addBookmark(item: FileBrowserItem): void {
    const remote = this.nautilusRemote();
    if (!remote) return;

    const exists = this.bookmarks().some(
      b => b.remote === remote.name && b.entry.Path === item.Path
    );

    if (exists) {
      this.notificationService.showInfo('Bookmark already exists');
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _remote, _fsType, ...entry } = item;

    this.nautilusService.addBookmark(entry, remote);
  }

  removeBookmark(bookmark: StarredItem): void {
    this.nautilusService.removeBookmark(bookmark);
  }

  openBookmark(bookmark: StarredItem): void {
    const remoteDetails = this.allRemotesLookup().find(r => r.name === bookmark.remote);
    if (!remoteDetails) {
      this.notificationService.showError(`Remote '${bookmark.remote}' for bookmark not found`);
      return;
    }
    this.selectRemote(remoteDetails);
    this.updatePath(bookmark.entry.Path);
    if (this.isMobile()) this.sidenav.close();
  }

  // ==========================================================================
  // Navigation & File Processing
  // ==========================================================================

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

    let normalized = rawInput.replace(/\\/g, '/');
    if (normalized.endsWith('/') && normalized.length > 1) normalized = normalized.slice(0, -1);

    const known = this.allRemotesLookup();

    // 1. Local Drive Match
    const driveMatch = known.find(
      r => r.fs_type === 'local' && normalized.toLowerCase().startsWith(r.name.toLowerCase())
    );
    if (driveMatch) {
      const remaining = normalized.substring(driveMatch.name.length);
      const cleanPath = remaining.startsWith('/') ? remaining.substring(1) : remaining;
      this._navigate(driveMatch, cleanPath, true);
      return;
    }

    // 2. Rclone Syntax Match
    const colonIdx = normalized.indexOf(':');
    if (colonIdx > -1) {
      const rName = normalized.substring(0, colonIdx);
      const rPath = normalized.substring(colonIdx + 1);
      const remoteMatch = known.find(r => r.name === rName);
      const targetRemote = remoteMatch || {
        name: rName,
        label: rName,
        type: 'cloud',
        fs_type: 'remote',
        isMounted: false,
      };
      const cleanPath = rPath.startsWith('/') ? rPath.substring(1) : rPath;
      this._navigate(targetRemote, cleanPath, true);
      return;
    }

    // 3. Unix Root Match
    if (normalized.startsWith('/')) {
      const root = known.find(r => r.name === '/');
      if (root) {
        this._navigate(root, normalized.substring(1), true);
        return;
      }
    }

    // 4. Relative Path
    const currentPath = this.currentPath();
    const newPath = currentPath ? `${currentPath}/${normalized}` : normalized;
    this.updatePath(newPath);
  }

  navigateTo(item: FileBrowserItem): void {
    if (item.IsDir) {
      if (this.starredMode() && item._remote) {
        const remote = this.allRemotesLookup().find(r => r.name === item._remote);
        if (remote) {
          this.starredMode.set(false);
          this._navigate(remote, item.Path, true);
        } else {
          this.notificationService.showError(`Remote '${item._remote}' not found.`);
        }
      } else {
        this.updatePath(item.Path);
      }
    } else {
      this.openFilePreview(item);
    }
  }

  // --- Internal Navigation ---
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

    const updatedTab: Tab = {
      ...tab,
      remote,
      path,
      title: path.split('/').pop() || remote?.label || 'Files',
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

  // --- Tabs Management ---
  createTab(remote: ExplorerRoot | null, path = ''): void {
    const id = ++this.interfaceTabCounter;
    const t = {
      id,
      title: remote?.label || 'New Tab',
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

  // --- Context Menus & Interactions ---

  refresh(): void {
    this.refreshTrigger.update(v => v + 1);
  }

  onItemClick(item: Entry, event: Event, index: number): void {
    event.stopPropagation();
    if (this.isPickerMode() && !this.isItemSelectable(item)) return;

    const sel = new Set(this.selectedItems());
    const multi = !this.isPickerMode() || this.pickerOptions().multiSelection !== false;
    const e = event as MouseEvent | KeyboardEvent;

    if (e.shiftKey && this.lastSelectedIndex !== null && multi) {
      sel.clear();
      const start = Math.min(this.lastSelectedIndex, index);
      const end = Math.max(this.lastSelectedIndex, index);
      const files = this.files();
      for (let i = start; i <= end; i++) sel.add(files[i].Path);
    } else if (e.ctrlKey && multi) {
      if (sel.has(item.Path)) sel.delete(item.Path);
      else sel.add(item.Path);
      this.lastSelectedIndex = index;
    } else {
      sel.clear();
      sel.add(item.Path);
      this.lastSelectedIndex = index;
    }

    this.syncSelection(sel);
  }

  // Context Menu Handlers (Item, Background, Remote, Bookmark)
  // Handled by CDK Context Menu now

  // Helper to set item when menu opens (called from HTML)
  setContextItem(item: Entry | null): void {
    this.contextMenuItem = item;
  }

  // Menu Actions
  openContextMenuOpen(): void {
    if (this.contextMenuItem) this.navigateTo(this.contextMenuItem as FileBrowserItem);
  }

  openContextMenuOpenInNewTab(): void {
    if (this.contextMenuItem?.IsDir) {
      this.createTab(this.nautilusRemote(), this.contextMenuItem.Path);
    }
  }

  openContextMenuCopyPath(): void {
    if (!this.contextMenuItem) return;
    const remote = this.nautilusRemote();
    const prefix = remote?.name;
    const full =
      remote?.fs_type === 'remote'
        ? `${prefix}:${this.contextMenuItem.Path}`
        : `${prefix}/${this.contextMenuItem.Path}`;
    navigator.clipboard?.writeText(full);
  }

  openContextMenuSelectToggle(): void {
    if (this.contextMenuItem) {
      const sel = new Set(this.selectedItems());
      if (sel.has(this.contextMenuItem.Path)) sel.delete(this.contextMenuItem.Path);
      else sel.add(this.contextMenuItem.Path);
      this.syncSelection(sel);
    }
  }

  openContextMenuProperties(): void {
    this.dialog.open(PropertiesModalComponent, {
      data: {
        remoteName: this.nautilusRemote()?.name,
        path: this.contextMenuItem?.Path || this.currentPath(),
        fs_type: this.nautilusRemote()?.fs_type,
        item: this.contextMenuItem,
      },
    });
  }

  async openContextMenuNewFolder(): Promise<void> {
    const remote = this.nautilusRemote();
    if (!remote) {
      return;
    }
    const normalized =
      remote.fs_type === 'remote'
        ? this.pathSelectionService.normalizeRemoteForRclone(remote.name)
        : remote.name;

    const ref = this.dialog.open(InputModalComponent, {
      data: {
        title: 'New Folder',
        label: 'Folder name',
        icon: 'folder',
        placeholder: 'Enter folder name',
        existingNames: (this.files() || []).map(f => f.Name),
      },
      disableClose: true,
    });

    try {
      const folderName = await firstValueFrom(ref.afterClosed());
      if (!folderName) {
        return;
      }
      const current = this.currentPath();
      const sep =
        remote.fs_type === 'local' && (current === '' || current.endsWith('/')) ? '' : '/';
      const newPath = current ? `${current}${sep}${folderName}` : folderName;
      await this.remoteManagement.makeDirectory(normalized, newPath);
      this.refresh();
    } catch {
      this.notificationService.showError('Failed to create folder');
    }
  }

  async openRemoteAboutFromSidebar(): Promise<void> {
    const r = this.sideContextRemote();
    if (!r) return;
    const normalized =
      r.fs_type === 'remote' ? this.pathSelectionService.normalizeRemoteForRclone(r.name) : r.name;
    this.dialog.open(RemoteAboutModalComponent, {
      data: { remote: { displayName: r.name, normalizedName: normalized, type: r.type } },
      ...STANDARD_MODAL_SIZE,
    });
  }

  async openSidebarCleanup(): Promise<void> {
    const r = this.sideContextRemote();
    if (!r) return;
    const confirmed = await this.notificationService.confirmModal(
      'Empty Trash',
      `Remove trashed files from ${r.name}?`
    );
    if (!confirmed) {
      return;
    }
    try {
      const normalized =
        r.fs_type === 'remote'
          ? this.pathSelectionService.normalizeRemoteForRclone(r.name)
          : r.name;
      await this.remoteManagement.cleanup(normalized);
      this.notificationService.showSuccess('Trash emptied');
    } catch (e) {
      this.notificationService.showError('Failed to empty trash: ' + (e as Error).message);
    }
  }

  deleteContextBookmark(): void {
    if (this.bookmarkContextItem) {
      this.removeBookmark(this.bookmarkContextItem);
    }
  }

  openBookmarkProperties(): void {
    const bm = this.bookmarkContextItem;
    if (!bm) return;
    const remoteDetails = this.allRemotesLookup().find(r => r.name === bm.remote);
    if (!remoteDetails) {
      this.notificationService.showError(`Remote '${bm.remote}' for bookmark not found`);
      return;
    }
    this.dialog.open(PropertiesModalComponent, {
      data: {
        remoteName: bm.remote,
        path: bm.entry.Path,
        fs_type: remoteDetails.fs_type,
        item: bm.entry,
      },
    });
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
    const remote = this.nautilusRemote();
    if (!remote) return;
    const actualRemoteName = item._remote || remote.name;
    const fsType = item._remote && item._remote !== remote.name ? 'remote' : remote.fs_type;

    const files = this.files();
    const idx = files.findIndex(f => f.Path === item.Path);
    this.fileViewerService.open(files, idx, actualRemoteName, fsType);
  }

  confirmSelection(): void {
    let paths = Array.from(this.selectedItems());
    const remote = this.nautilusRemote();
    if (paths.length === 0 && this.pickerOptions().selectFolders) {
      paths = [this.currentPath()];
    }
    const prefix =
      remote?.fs_type === 'remote'
        ? this.pathSelectionService.normalizeRemoteForRclone(remote.name)
        : remote?.name;

    const fullPaths = paths.map(p => {
      if (remote?.fs_type === 'local') {
        const sep = prefix?.endsWith('/') ? '' : '/';
        return `${prefix}${sep}${p}`;
      }
      return `${prefix}/${p}`;
    });
    this.nautilusService.closeFilePicker(fullPaths);
  }

  onClose(): void {
    this.nautilusService.closeFilePicker(null);
  }

  toggleStar(item: FileBrowserItem): void {
    // We now have the identifier directly on the item!
    if (!item._remote) return;

    // The item structure is already compatible with Entry,
    // but we strip the extra UI props before saving to keep storage clean
    const { _remote, ...entry } = item;

    this.nautilusService.toggleStar(_remote, entry);
  }

  isStarred(item: FileBrowserItem): boolean {
    const remote = item._remote || this.nautilusRemote()?.name;
    if (!remote) return false;
    return this.nautilusService.isStarred(remote, item.Path);
  }

  updateSelectionSummary(): void {
    const c = this.selectedItems().size;
    this.selectionSummary.set(c > 0 ? `${c} selected` : '');
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
    if (opts.selectFolders && !item.IsDir) return false;
    if (opts.selectFiles && item.IsDir) return false;
    return true;
  }

  unmount(mp: string, name: string): void {
    this.mountManagement
      .unmountRemote(mp, name)
      .then(() => this.mountManagement.getMountedRemotes());
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

    // Find current or next larger index
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
    this.appSettingsService.saveSetting('nautilus', key, this.iconSize());
  }

  setLayout(l: 'grid' | 'list'): void {
    this.layout.set(l);
    // Snap to nearest size
    const sizes = l === 'list' ? this.LIST_ICON_SIZES : this.GRID_ICON_SIZES;
    const cur = this.iconSize();
    const nearest = sizes.reduce((prev, curr) =>
      Math.abs(curr - cur) < Math.abs(prev - cur) ? curr : prev
    );
    this.iconSize.set(nearest);
    this.appSettingsService.saveSetting('nautilus', 'default_layout', l);
  }

  setSort(k: string): void {
    this.sortKey.set(k);
    this.appSettingsService.saveSetting('nautilus', 'sort_key', k);
    this.refresh();
  }

  private readonly defaultSortDirections: Record<string, 'asc' | 'desc'> = {
    name: 'asc',
    size: 'desc',
    modified: 'desc',
  };

  /**
   * Called when a table header is clicked.
   * Toggles direction if already sorted by this column, otherwise sets default.
   */
  toggleSort(column: string): void {
    const [currentCol, currentDir] = this.sortKey().split('-');
    const newDir =
      currentCol === column && currentDir === 'asc'
        ? 'desc'
        : currentCol === column
          ? 'asc'
          : (this.defaultSortDirections[column] ?? 'asc');
    this.setSort(`${column}-${newDir}`);
  }

  toggleShowHidden(v: boolean): void {
    this.showHidden.set(v);
    this.appSettingsService.saveSetting('nautilus', 'show_hidden_by_default', v);
  }

  selectStarred(): void {
    if (this.starredMode()) return;
    this.starredMode.set(true);
    this.nautilusRemote.set(null);
    this.currentPath.set('');
    this.selectedItems.set(new Set());
    this.updateSelectionSummary();
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

  // NEW: Select all files in the current view
  selectAll(): void {
    const allPaths = new Set(this.files().map(f => f.Path));
    this.syncSelection(allPaths);
  }

  // NEW: Copy the text of the current breadcrumb path
  copyCurrentLocation(): void {
    const path = this.fullPathInput();
    if (path) {
      navigator.clipboard?.writeText(path);
      this.notificationService.openSnackBar('Location copied to clipboard', 'Close');
    }
  }

  async runBackgroundCleanupChecks(remotes: ExplorerRoot[]): Promise<void> {
    this.cleanupSupportCache.update(c => {
      const u: Record<string, boolean> = {};
      remotes.forEach(r => (u[r.name] = false));
      return { ...c, ...u };
    });

    for (const r of remotes) {
      if (r.fs_type !== 'remote') continue;
      try {
        const normalized = this.pathSelectionService.normalizeRemoteForRclone(r.name);
        const info = (await this.remoteManagement
          .getFsInfo(normalized)
          .catch(() => null)) as FsInfo | null;
        if (info?.Features?.CleanUp) {
          this.cleanupSupportCache.update(c => ({ ...c, [r.name]: true }));
        }
      } catch {
        console.error('Failed to check cleanup support');
      }
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      const [layout, sortKey, showHidden] = await Promise.all([
        this.appSettingsService.getSettingValue<'grid' | 'list'>('nautilus.default_layout'),
        this.appSettingsService.getSettingValue<string>('nautilus.sort_key'),
        this.appSettingsService.getSettingValue<boolean>('nautilus.show_hidden_by_default'),
      ]);
      if (layout) this.layout.set(layout);
      if (sortKey) this.sortKey.set(sortKey);
      if (showHidden !== undefined) this.showHidden.set(showHidden);
    } catch (e) {
      console.warn('Settings load error', e);
    }
  }

  trackByFile(i: number, item: Entry): string {
    return item.ID || item.Path;
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
  trackByBookmark(i: number, b: StarredItem): string {
    return b.remote + b.entry.Path;
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
  }
}

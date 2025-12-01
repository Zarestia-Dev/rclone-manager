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
import { catchError, finalize, map, switchMap, take } from 'rxjs/operators';
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
import { ScrollingModule } from '@angular/cdk/scrolling';

// Services & Types
import {
  UiStateService,
  NautilusService,
  RemoteManagementService,
  MountManagementService,
  PathSelectionService,
  AppSettingsService,
} from '@app/services';
import {
  Entry,
  ExplorerRoot,
  LocalDrive,
  STANDARD_MODAL_SIZE,
  FileBrowserItem,
  FilePickerConfig,
} from '@app/types';

import { FormatFileSizePipe } from '@app/pipes';
import { AnimationsService } from 'src/app/shared/services/animations.service';
import { IconService } from 'src/app/shared/services/icon.service';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';

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
  | { kind: 'bookmark'; data: FileBrowserItem };

@Component({
  selector: 'app-nautilus',
  standalone: true,
  imports: [
    CommonModule,
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
    const opts = state.options;
    if (state.isOpen && opts?.selection === 'folders') return 'Select Folder';
    if (state.isOpen && opts?.selection === 'files') return 'Select File';
    if (state.isOpen) return 'Select Items';
    return 'Files';
  });
  public readonly isMobile = signal(window.innerWidth < 680);
  public readonly isSidenavOpen = signal(!this.isMobile());
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

  // --- Data ---
  public readonly bookmarks = this.nautilusService.bookmarks; // Direct signal
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
    const drives = (localDrives || []).map((drive: LocalDrive) => ({
      name: drive.name,
      label: drive.label || drive.name,
      type: 'hard-drive',
      fs_type: 'local' as const,
      isMounted: false,
    }));
    if (this.isPickerMode() && this.pickerOptions().mode === 'remote') return [];
    return drives;
  });

  // Computed: Cloud Remotes
  public readonly cloudRemotes = computed<ExplorerRoot[]>(() => {
    const [remoteNames, mountedRemotes, , configs] = this.rawRemotesData();
    let list = (remoteNames || []).map(name => {
      const mountedInfo = mountedRemotes.find((mr: unknown) => {
        const fs = (mr as { fs: string }).fs;
        return this.pathSelectionService.normalizeRemoteName(fs) === name;
      });
      const config = (configs as Record<string, { type?: string; Type?: string } | undefined>)[
        name
      ];
      return {
        name,
        label: name,
        type: config?.type || config?.Type || 'cloud',
        fs_type: 'remote' as const,
        isMounted: !!mountedInfo,
        mountPoint: mountedInfo?.mount_point,
      };
    });
    if (this.isPickerMode() && this.pickerOptions().mode === 'local') return [];
    const allowed = this.pickerOptions().allowedRemotes;
    if (this.isPickerMode() && allowed && allowed.length) {
      list = list.filter(r => allowed.includes(r.name));
    }
    return list;
  });

  // Computed: Sidebar Combined List
  public readonly sidebarLocalItems = computed<SidebarLocalItem[]>(() => {
    const drives = this.localDrives().map(d => ({ kind: 'drive', data: d }) as SidebarLocalItem);
    let marks = this.bookmarks();
    if (this.isPickerMode()) {
      const cfg = this.pickerOptions();
      marks = marks.filter(b => {
        if (cfg.mode === 'local' && b.meta.fsType !== 'local') return false;
        if (cfg.mode === 'remote' && b.meta.fsType !== 'remote') return false;
        if (cfg.allowedRemotes && b.meta.fsType === 'remote') {
          return cfg.allowedRemotes.includes((b.meta.remote || '').replace(/:$/, ''));
        }
        return true;
      });
    }
    const bookmarkItems = marks.map(b => ({ kind: 'bookmark', data: b }) as SidebarLocalItem);
    return [...drives, ...bookmarkItems];
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
                    fsType: remote.fs_type,
                    remoteType: remote.type,
                  },
                }) as FileBrowserItem
            );
          }),
          catchError(err => {
            console.error('Error fetching files:', err);
            this.errorState.set(err || 'Failed to load directory');
            this.notificationService.showError('Failed to load directory');
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
          if (cfg.mode === 'local' && i.meta.fsType !== 'local') return false;
          if (cfg.mode === 'remote' && i.meta.fsType !== 'remote') return false;
          if (cfg.allowedRemotes && i.meta.fsType === 'remote') {
            return cfg.allowedRemotes.includes((i.meta.remote || '').replace(/:$/, ''));
          }
          return true;
        });
      }
      return items;
    }
    return this.rawFiles();
  });

  // 2. Filtered files (hidden files)
  private readonly filteredFiles = computed(() => {
    const files = this.sourceFiles();
    if (this.showHidden() || this.starredMode()) return files;
    return files.filter(f => !f.entry.Name.startsWith('.'));
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
    { key: 'name-asc', label: 'A-Z' },
    { key: 'name-desc', label: 'Z-A' },
    { key: 'modified-desc', label: 'Last Modified' },
    { key: 'modified-asc', label: 'First Modified' },
    { key: 'size-desc', label: 'Size (Largest First)' },
    { key: 'size-asc', label: 'Size (Smallest First)' },
  ];

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
      const remotes = this.allRemotesLookup();
      const cache = untracked(this.cleanupSupportCache);
      const missing = remotes.filter(r => cache[r.name] === undefined && r.fs_type === 'remote');
      if (missing.length > 0) {
        this.runBackgroundCleanupChecks(missing);
      }
    });

    // Apply initialLocation when picker opens (once per open)
    effect(() => {
      const open = this.isPickerMode();
      const applied = this.initialLocationApplied();
      const cfg = this.pickerOptions();
      if (open && !applied) {
        // Avoid racing with async remotes/drives loading
        if (!this.isDataReadyForConfig(cfg)) return;
        const loc = cfg.initialLocation;
        if (loc && this.isLocationAllowedByConfig(loc, cfg)) {
          this.navigateToPath(loc);
        } else {
          this.ensureInitialRemoteForMode(cfg.mode, cfg.allowedRemotes);
        }
        this.initialLocationApplied.set(true);
      }
      if (!open && applied) this.initialLocationApplied.set(false);
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

  private ensureInitialRemoteForMode(mode: FilePickerConfig['mode'], allowed?: string[]): void {
    if (mode === 'local') {
      const current = this.nautilusRemote();
      if (current?.fs_type === 'local') return;
      const first = this.localDrives()[0];
      if (first) this.selectRemote(first);
      return;
    }
    if (mode === 'remote') {
      const current = this.nautilusRemote();
      if (current?.fs_type === 'remote') {
        if (!allowed || allowed.includes(current.name)) return;
      }
      let remotes = this.cloudRemotes();
      if (allowed && allowed.length) remotes = remotes.filter(r => allowed.includes(r.name));
      const first = remotes[0];
      if (first) this.selectRemote(first);
      return;
    }
    // both -> no change
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
      this.notificationService.openSnackBar(`'${item.entry.Name}' added to Starred`, 'Undo');
    }
  }

  onDropToLocal(event: CdkDragDrop<FileBrowserItem[]>): void {
    if (event.previousContainer === event.container) {
      const drivesCount = this.localDrives().length;
      const prevIndex = event.previousIndex - drivesCount;
      const currIndex = event.currentIndex - drivesCount;
      if (prevIndex >= 0 && currIndex >= 0 && prevIndex < this.bookmarks().length) {
        this.nautilusService.reorderItems('bookmarks', prevIndex, currIndex);
      }
    } else {
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
      this.notificationService.showError(`Remote '${bookmark.meta.remote}' for bookmark not found`);
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

    let normalized = rawInput.replace(/\\/g, '/');
    if (normalized.endsWith('/') && normalized.length > 1) normalized = normalized.slice(0, -1);

    const known = this.allRemotesLookup();

    // Local Drive Match
    const driveMatch = known.find(
      r => r.fs_type === 'local' && normalized.toLowerCase().startsWith(r.name.toLowerCase())
    );
    if (driveMatch) {
      const remaining = normalized.substring(driveMatch.name.length);
      const cleanPath = remaining.startsWith('/') ? remaining.substring(1) : remaining;
      this._navigate(driveMatch, cleanPath, true);
      return;
    }

    // Rclone Syntax Match
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

    // Unix Root
    if (normalized.startsWith('/')) {
      const root = known.find(r => r.name === '/');
      if (root) {
        this._navigate(root, normalized.substring(1), true);
        return;
      }
    }

    const currentPath = this.currentPath();
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
          this.notificationService.showError(`Remote '${remoteName}' not found.`);
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

  // --- Tabs ---
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
      this.notificationService.showError('Could not resolve remote for this item');
    }
  }

  openContextMenuCopyPath(): void {
    if (!this.contextMenuItem) return;
    const remote = this.nautilusRemote();
    const prefix = remote?.name;
    // Use meta.remote if available (for starred items)
    const remoteName = this.contextMenuItem.meta.remote || prefix;
    const sep =
      this.contextMenuItem.meta.fsType === 'remote' || remote?.fs_type === 'remote' ? ':' : '/';

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

  openContextMenuProperties(): void {
    const currentRemote = this.nautilusRemote();
    const item = this.contextMenuItem;
    const path = item?.entry.Path || this.currentPath();

    // Normalize remote name for API calls
    let remoteName = item?.meta.remote || currentRemote?.name;
    const fsType = item?.meta.fsType || currentRemote?.fs_type;

    if (remoteName && fsType === 'remote') {
      remoteName = this.pathSelectionService.normalizeRemoteForRclone(remoteName);
    }

    this.dialog.open(PropertiesModalComponent, {
      data: {
        remoteName: remoteName,
        path: path,
        fs_type: fsType,
        item: item?.entry,
        remoteType: item?.meta.remoteType || currentRemote?.type,
      },
    });
  }

  async openContextMenuNewFolder(): Promise<void> {
    const remote = this.nautilusRemote();
    if (!remote) return;

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
        existingNames: (this.files() || []).map(f => f.entry.Name),
      },
      disableClose: true,
    });

    try {
      const folderName = await firstValueFrom(ref.afterClosed());
      if (!folderName) return;
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
    if (!confirmed) return;
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

    // Normalize remote name for API calls
    let remoteName = bm.meta.remote;
    if (bm.meta.fsType === 'remote') {
      remoteName = this.pathSelectionService.normalizeRemoteForRclone(remoteName);
    }

    this.dialog.open(PropertiesModalComponent, {
      data: {
        remoteName: remoteName,
        path: bm.entry.Path,
        fs_type: bm.meta.fsType,
        item: bm.entry,
        remoteType: bm.meta.remoteType,
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
    const currentRemote = this.nautilusRemote();
    const actualRemoteName = item.meta.remote || currentRemote?.name;
    const fsType = item.meta.fsType || currentRemote?.fs_type || 'remote';

    if (!actualRemoteName) {
      this.notificationService.showError('Unable to open file: missing remote context');
      return;
    }

    // Pass Entry[] to the viewer
    const entries = this.files().map(f => f.entry);
    const idx = this.files().findIndex(f => f.entry.Path === item.entry.Path);
    this.fileViewerService.open(entries, idx, actualRemoteName, fsType);
  }

  confirmSelection(): void {
    let paths = Array.from(this.selectedItems());
    const remote = this.nautilusRemote();
    if (paths.length === 0 && this.pickerOptions().selection === 'folders') {
      paths = [this.currentPath()];
    }
    const minSel = this.pickerOptions().minSelection ?? 0;
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

    if (this.isPickerMode() && fullPaths.length < minSel) {
      this.notificationService.showError(
        `Please select at least ${minSel} item${minSel > 1 ? 's' : ''}.`
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
    if (opts.selection === 'folders' && !item.IsDir) return false;
    if (opts.selection === 'files' && item.IsDir) return false;
    if (!item.IsDir && opts.allowedExtensions && opts.allowedExtensions.length) {
      const name = item.Name.toLowerCase();
      const ok = opts.allowedExtensions.some((ext: string) => name.endsWith(ext.toLowerCase()));
      if (!ok) return false;
    }
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
    this.appSettingsService.saveSetting('nautilus', 'show_hidden_by_default', v);
  }

  selectStarred(): void {
    if (this.starredMode()) return;
    this.starredMode.set(true);
    this.nautilusRemote.set(null);
    this.currentPath.set('');
    this.selectedItems.set(new Set());
    this.errorState.set(null);
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

  selectAll(): void {
    const allPaths = new Set(this.files().map(f => f.entry.Path));
    this.syncSelection(allPaths);
  }

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
  }
}

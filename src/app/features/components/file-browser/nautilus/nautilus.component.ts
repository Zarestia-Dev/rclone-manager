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
} from '@angular/core';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, BehaviorSubject, combineLatest, from, of } from 'rxjs';
import { catchError, finalize, map, switchMap, startWith, take } from 'rxjs/operators';
import { CommonModule } from '@angular/common';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenav, MatSidenavModule } from '@angular/material/sidenav';
import { MatButtonModule } from '@angular/material/button';
import { MatGridListModule } from '@angular/material/grid-list';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatDialog } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { FormsModule } from '@angular/forms';

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
import { Entry, LocalDrive, STANDARD_MODAL_SIZE } from '@app/types';
import { FormatFileSizePipe } from '@app/pipes';
import { AnimationsService } from 'src/app/shared/services/animations.service';
import { IconService } from 'src/app/shared/services/icon.service';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import { PropertiesModalComponent } from '../properties/properties-modal.component';
import { InputModalComponent } from 'src/app/shared/modals/input-modal/input-modal.component';
import { NotificationService } from 'src/app/shared/services/notification.service';
import { RemoteAboutModalComponent } from '../remote/remote-about-modal.component';

// --- INTERNAL TYPES ---
// Starred items are managed centrally in NautilusService

// Unified interface for Sidebar items (both Local Drives and Remotes)
export interface ExplorerRoot {
  name: string; // "C:" or "gdrive"
  label: string; // "Local Disk" or "gdrive"
  type: string; // Icon identifier (e.g. 'hard-drive', 'cloud')
  fs_type: 'local' | 'remote';
  isMounted: boolean;
  mountPoint?: string;
}

interface FsInfo {
  Features?: {
    CleanUp?: boolean;
  };
}

type NautilusEntry = Entry & { _nautilusRemote: string };

@Component({
  selector: 'app-nautilus',
  standalone: true,
  imports: [
    CommonModule,
    MatListModule,
    MatIconModule,
    MatToolbarModule,
    MatSidenavModule,
    MatButtonModule,
    MatGridListModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatMenuModule,
    MatProgressSpinnerModule,
    MatRadioModule,
    MatCheckboxModule,
    FormsModule,
    FormatFileSizePipe,
  ],
  templateUrl: './nautilus.component.html',
  styleUrl: './nautilus.component.scss',
  animations: [AnimationsService.slideOverlay()],
})
export class NautilusComponent implements OnInit, OnDestroy {
  // --- INJECTIONS ---
  private uiStateService = inject(UiStateService);
  private nautilusService = inject(NautilusService);
  private remoteManagement = inject(RemoteManagementService);
  private mountManagement = inject(MountManagementService);
  private pathSelectionService = inject(PathSelectionService);
  public iconService = inject(IconService);
  public fileViewerService = inject(FileViewerService);
  private dialog = inject(MatDialog);
  private notificationService = inject(NotificationService);
  private appSettingsService = inject(AppSettingsService);

  // --- UI STATE SIGNALS ---
  public isLoading = signal(false);
  public title = signal('Files');
  public isMobile = signal(window.innerWidth < 680);
  public isSidenavOpen = signal(!this.isMobile());
  public sidenavMode = computed(() => (this.isMobile() ? 'over' : 'side'));

  // View Configuration
  public layout = signal<'grid' | 'list'>('grid');
  public sortKey = signal('name-asc');
  public sortDirection = computed(() => (this.sortKey().endsWith('asc') ? 'asc' : 'desc'));
  public showHidden = signal(false);

  private readonly LIST_ICON_SIZES = [24, 40, 64];
  private readonly GRID_ICON_SIZES = [40, 50, 72, 120, 240];
  public iconSize = signal(this.GRID_ICON_SIZES[1]); // Default 50

  // Selection & Picker Mode
  public isPickerMode = signal(false);
  public pickerOptions = signal<FilePickerOptions>({});
  public selectedItems = new BehaviorSubject<Set<string>>(new Set());
  public selectionSummary = signal('');
  private lastSelectedIndex: number | null = null;

  // --- NAVIGATION STATE ---
  // The current "Root" (Drive or Remote)
  public nautilusRemote = new BehaviorSubject<ExplorerRoot | null>(null);
  // The path RELATIVE to the Root
  public currentPath = new BehaviorSubject<string>('');

  public pathSegments = toSignal(
    this.currentPath.pipe(map(path => (path ? path.split('/').filter(p => p) : []))),
    { initialValue: [] }
  );

  // Path Editing
  public isEditingPath = signal(false);
  @ViewChild('pathInput') pathInput?: ElementRef<HTMLInputElement>;
  @ViewChild('pathScrollView') pathScrollView?: ElementRef<HTMLDivElement>;
  @ViewChild(MatMenuTrigger) viewMenuTrigger?: MatMenuTrigger;

  // Tabs System
  interfaceTabCounter = 0;
  public tabs: {
    id: number;
    title: string;
    remote: ExplorerRoot | null;
    path: string;
    selection: Set<string>;
    history: { remote: ExplorerRoot | null; path: string }[];
    historyIndex: number;
  }[] = [];
  public activeTabIndex = signal(0);
  public canGoBack = signal(false);
  public canGoForward = signal(false);

  // --- CONTEXT MENUS ---
  public contextMenuVisible = signal(false);
  public contextMenuX = signal(0);
  public contextMenuY = signal(0);
  public contextMenuItem: Entry | null = null;

  public sideContextVisible = signal(false);
  public sideContextX = signal(0);
  public sideContextY = signal(0);
  public sideContextRemote = signal<ExplorerRoot | null>(null);

  // --- DATA SOURCES & SIGNALS ---
  private refreshTrigger = new BehaviorSubject<void>(undefined);
  public starredMode = signal(false);

  // 1. Combined Remotes List (Local Drives + Rclone Remotes)
  public remotesWithMeta = toSignal(
    combineLatest([
      this.remoteManagement.remotes$,
      this.mountManagement.mountedRemotes$,
      from(this.remoteManagement.getLocalDrives()),
      from(this.remoteManagement.getAllRemoteConfigs().catch(() => ({}))),
    ]).pipe(
      map(([remoteNames, mountedRemotes, localDrives, configs]) => {
        // Map Rclone Remotes
        const rcloneRemotes: ExplorerRoot[] = (remoteNames || []).map(name => {
          const mountedInfo = mountedRemotes.find(mr => mr.fs.replace(/:$/, '') === name);
          const config = (configs as Record<string, unknown>)[name] as
            | { type?: string; Type?: string }
            | undefined;
          return {
            name,
            label: name,
            type: config?.type || config?.Type || 'cloud',
            fs_type: 'remote',
            isMounted: !!mountedInfo,
            mountPoint: mountedInfo?.mount_point,
          };
        });

        // Map Local Drives (from Rust)
        const localList: ExplorerRoot[] = localDrives.map((drive: LocalDrive) => ({
          name: drive.name, // e.g. "C:" or "/"
          label: drive.label || drive.name,
          type: 'hard-drive', // Force icon type for locals
          fs_type: 'local',
          isMounted: false,
        }));

        return [...localList, ...rcloneRemotes];
      })
    ),
    { initialValue: [] as ExplorerRoot[] }
  );

  // 2. Filtered Remotes (for Picker Mode restrictions)
  public filteredRemotes = computed(() => {
    const list = this.remotesWithMeta();
    const restrict = this.pickerOptions().restrictSingle;
    return restrict ? list.filter(r => r.name === restrict) : list;
  });

  // 3. Computed Path Input String (for UI display)
  public fullPathInput = computed(() => {
    if (this.starredMode()) return '';

    const remote = this.nautilusRemote.getValue();
    const path = this.currentPath.getValue();

    if (!remote) return path;

    // Handle Local Drives (e.g. "C:" + "/Windows" -> "C:/Windows")
    if (remote.fs_type === 'local') {
      const separator = remote.name.endsWith('/') ? '' : '/';
      return path ? `${remote.name}${separator}${path}` : remote.name;
    }

    // Handle Remotes (e.g. "gdrive" + "folder" -> "gdrive:folder")
    const prefix = remote.name.includes(':') ? remote.name : `${remote.name}:`;
    const cleanPath = path.startsWith('/') ? path.substring(1) : path;
    return path ? `${prefix}${cleanPath}` : prefix;
  });

  // 4. Main Files Pipeline
  private rawFiles = toSignal(
    combineLatest([this.nautilusRemote, this.currentPath, this.refreshTrigger]).pipe(
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
            return list.map(f => ({ ...f, _nautilusRemote: remote.name }));
          }),
          catchError(err => {
            console.error('Error fetching files:', err);
            return of([]);
          }),
          startWith([]),
          finalize(() => this.isLoading.set(false))
        );
      })
    ),
    { initialValue: [] as NautilusEntry[] }
  );

  // 2. Computed View (Sorts & Filters instantly when settings change)
  public files = computed(() => {
    const raw = this.rawFiles();
    // This automatically tracks changes to showHidden, sortKey, and starredMode
    return this.processFilesDisplay(raw);
  });

  @Output() closeOverlay = new EventEmitter<void>();
  @ViewChild('sidenav') sidenav!: MatSidenav;

  public sortOptions = [
    { key: 'name-asc', label: 'A-Z' },
    { key: 'name-desc', label: 'Z-A' },
    { key: 'modified-desc', label: 'Last Modified' },
    { key: 'modified-asc', label: 'First Modified' },
    { key: 'size-desc', label: 'Size (Largest First)' },
    { key: 'size-asc', label: 'Size (Smallest First)' },
  ];

  // Cleanup check support cache
  public cleanupSupportCache = signal<Record<string, boolean>>({});
  public sideRemoteSupportsCleanup = computed(() => {
    const r = this.sideContextRemote();
    return r ? (this.cleanupSupportCache()[r.name] ?? false) : false;
  });

  constructor() {
    // Picker State Listener
    this.nautilusService.filePickerState$.pipe(takeUntilDestroyed()).subscribe(state => {
      this.isPickerMode.set(state.isOpen);
      if (state.isOpen && state.options) {
        this.pickerOptions.set(state.options);
        this.title.set(state.options.selectFolders ? 'Select Folder' : 'Select Files');
      } else {
        this.title.set('Files');
      }
    });

    // Auto-scroll Path Breadcrumbs
    effect(() => {
      this.pathSegments();
      setTimeout(() => {
        if (this.pathScrollView?.nativeElement) {
          const el = this.pathScrollView.nativeElement;
          el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
        }
      }, 50);
    });

    // Focus Input on Edit
    effect(() => {
      if (this.isEditingPath()) {
        setTimeout(() => this.pathInput?.nativeElement?.select(), 10);
      }
    });

    // Background Cleanup Check Effect
    effect(() => {
      const remotes = this.remotesWithMeta();
      const cache = untracked(this.cleanupSupportCache);
      const missing = remotes.filter(r => cache[r.name] === undefined && r.fs_type === 'remote');
      if (missing.length > 0) {
        this.runBackgroundCleanupChecks(missing);
      }
    });

    this.loadSettings();
  }

  async ngOnInit(): Promise<void> {
    try {
      await Promise.all([
        this.remoteManagement.getRemotes(),
        this.mountManagement.getMountedRemotes(),
      ]);

      // Init first tab with first available drive or remote
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

      window.addEventListener('click', this._globalClickListener);
      window.addEventListener('keydown', this._globalEscapeHandler, true);
    } catch (e) {
      console.warn('Init failed', e);
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('click', this._globalClickListener);
    window.removeEventListener('keydown', this._globalEscapeHandler, true);
  }

  // --- CORE LOGIC ---

  private processFilesDisplay(files: NautilusEntry[]): NautilusEntry[] {
    let result = [...files];

    if (this.starredMode()) {
      // Aggregate all starred items from the NautilusService
      const list = this.nautilusService.starredItems();
      result = list.map(s => ({ ...s.entry, _nautilusRemote: s.remote }));
    } else {
      if (!this.showHidden()) {
        result = result.filter(f => !f.Name.startsWith('.'));
      }
    }

    // Sorting
    const [key, dir] = this.sortKey().split('-');
    const multiplier = dir === 'asc' ? 1 : -1;

    return result.sort((a, b) => {
      if (a.IsDir !== b.IsDir) return a.IsDir ? -1 : 1; // Folders first
      switch (key) {
        case 'name':
          return a.Name.localeCompare(b.Name) * multiplier;
        case 'size':
          return (a.Size - b.Size) * multiplier;
        case 'modified':
          return (new Date(a.ModTime).getTime() - new Date(b.ModTime).getTime()) * multiplier;
        default:
          return 0;
      }
    });
  }

  // --- NAVIGATION ---

  selectRemote(remote: ExplorerRoot | null): void {
    if (!remote) return;
    this.starredMode.set(false);
    // Determine root path based on OS. Rust 'get_local_drives' returns proper roots.
    // We navigate to empty relative path '' because 'remote.name' IS the root.
    this._navigate(remote, '', true);
  }

  /**
   * Parses user input strings like "C:/Users" or "gdrive:folder"
   */
  navigateToPath(rawInput: string): void {
    this.isEditingPath.set(false);
    if (this.starredMode()) this.starredMode.set(false);
    let normalized = rawInput.replace(/\\/g, '/');
    if (normalized.endsWith('/') && normalized.length > 1) normalized = normalized.slice(0, -1);

    const known = this.remotesWithMeta();

    // 1. Check for Drive Letter match (e.g. input "C:/Users", drive "C:")
    // We check if input starts with a known local drive name (case-insensitive for Windows)
    const driveMatch = known.find(
      r => r.fs_type === 'local' && normalized.toLowerCase().startsWith(r.name.toLowerCase())
    );

    if (driveMatch) {
      const remaining = normalized.substring(driveMatch.name.length);
      const cleanPath = remaining.startsWith('/') ? remaining.substring(1) : remaining;
      this._navigate(driveMatch, cleanPath, true);
      return;
    }

    // 2. Check for Rclone Syntax (Name:Path)
    const colonIdx = normalized.indexOf(':');
    if (colonIdx > -1) {
      const rName = normalized.substring(0, colonIdx);
      const rPath = normalized.substring(colonIdx + 1);

      const remoteMatch = known.find(r => r.name === rName);
      // Fallback: create temp remote object if not in list (Rclone might still accept it)
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

    // 3. Unix Root ("/")
    if (normalized.startsWith('/')) {
      const root = known.find(r => r.name === '/');
      if (root) {
        this._navigate(root, normalized.substring(1), true);
        return;
      }
    }

    // 4. Relative Path (append to current)
    const currentPath = this.currentPath.getValue();
    const newPath = currentPath ? `${currentPath}/${normalized}` : normalized;
    this.updatePath(newPath);
  }

  navigateTo(item: NautilusEntry): void {
    if (item.IsDir) {
      if (this.starredMode() && item._nautilusRemote) {
        // Jump to starred folder's actual location
        const remote = this.remotesWithMeta().find(r => r.name === item._nautilusRemote);
        if (remote) {
          this.starredMode.set(false);
          this._navigate(remote, item.Path, true);
        } else {
          this.notificationService.showError(`Remote '${item._nautilusRemote}' not found.`);
        }
      } else {
        this.updatePath(item.Path);
      }
    } else {
      this.openFilePreview(item);
    }
  }

  updatePath(newPath: string): void {
    this._navigate(this.nautilusRemote.getValue(), newPath, true);
  }

  navigateToSegment(index: number): void {
    const segments = this.pathSegments();
    const newPath = segments.slice(0, index + 1).join('/');
    this.updatePath(newPath);
  }

  goBack(): void {
    const tab = this.tabs[this.activeTabIndex()];
    if (tab && tab.historyIndex > 0) {
      tab.historyIndex--;
      const entry = tab.history[tab.historyIndex];
      this._navigate(entry.remote, entry.path, false);
    }
  }

  goForward(): void {
    const tab = this.tabs[this.activeTabIndex()];
    if (tab && tab.historyIndex < tab.history.length - 1) {
      tab.historyIndex++;
      const entry = tab.history[tab.historyIndex];
      this._navigate(entry.remote, entry.path, false);
    }
  }

  private _navigate(remote: ExplorerRoot | null, path: string, newHistory: boolean): void {
    const tab = this.tabs[this.activeTabIndex()];
    if (!tab) return;

    if (newHistory) {
      // Truncate future history if branching off
      if (tab.historyIndex < tab.history.length - 1) {
        tab.history = tab.history.slice(0, tab.historyIndex + 1);
      }
      tab.history.push({ remote, path });
      tab.historyIndex++;
    }

    tab.remote = remote;
    tab.path = path;
    // Friendly title: Current Folder Name or Drive Label
    tab.title = path.split('/').pop() || remote?.label || 'Files';
    tab.selection.clear();

    this.nautilusRemote.next(remote);
    this.currentPath.next(path);
    this.selectedItems.next(tab.selection);
    this.updateSelectionSummary();
    this.updateHistoryButtons();
  }

  // --- TAB MANAGEMENT ---
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
    this.tabs.push(t);
    this.activeTabIndex.set(this.tabs.length - 1);
    this._navigate(remote, path, true);
  }

  closeTab(i: number): void {
    if (i < 0 || i >= this.tabs.length) return;
    this.tabs.splice(i, 1);

    // Create new tab if last one closed
    if (this.tabs.length === 0) {
      this.createTab(null, '');
      return;
    }

    // Adjust index
    let newIndex = this.activeTabIndex();
    if (i <= newIndex) newIndex = Math.max(0, newIndex - 1);

    this.switchTab(newIndex);
  }

  switchTab(i: number): void {
    if (i < 0 || i >= this.tabs.length) return;
    this.activeTabIndex.set(i);
    const t = this.tabs[i];
    this._navigate(t.remote, t.path, false); // No new history on switch
  }

  // --- ACTIONS ---

  refresh(): void {
    this.refreshTrigger.next();
    this.contextMenuVisible.set(false);
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

  onItemClick(item: Entry, event: any, index: number): void {
    event.stopPropagation();
    if (this.isPickerMode() && !this.isItemSelectable(item)) return;

    const sel = new Set(this.selectedItems.getValue());
    const multi = !this.isPickerMode() || this.pickerOptions().multiSelection !== false;

    // Shift/Ctrl selection logic
    if (event.shiftKey && this.lastSelectedIndex !== null && multi) {
      sel.clear();
      const start = Math.min(this.lastSelectedIndex, index);
      const end = Math.max(this.lastSelectedIndex, index);
      const files = this.files();
      for (let i = start; i <= end; i++) sel.add(files[i].Path);
    } else if (event.ctrlKey && multi) {
      if (sel.has(item.Path)) {
        sel.delete(item.Path);
      } else {
        sel.add(item.Path);
      }
      this.lastSelectedIndex = index;
    } else {
      sel.clear();
      sel.add(item.Path);
      this.lastSelectedIndex = index;
    }

    this.selectedItems.next(sel);
    this.tabs[this.activeTabIndex()].selection = sel;
    this.updateSelectionSummary();
  }

  async openFilePreview(item: NautilusEntry): Promise<void> {
    const remote = this.nautilusRemote.getValue();
    const actualRemoteName = item._nautilusRemote || remote?.name;
    const fsType =
      item._nautilusRemote && item._nautilusRemote !== remote?.name
        ? 'remote' // Assume aggregated items are remote usually, or check meta
        : remote?.fs_type || 'remote';

    if (!actualRemoteName) return;

    const files = this.files();
    const idx = files.findIndex(f => f.Path === item.Path);
    this.fileViewerService.open(files, idx, actualRemoteName, fsType);
  }

  confirmSelection(): void {
    let paths = Array.from(this.selectedItems.getValue());
    const remote = this.nautilusRemote.getValue();

    if (paths.length === 0 && this.pickerOptions().selectFolders) {
      paths = [this.currentPath.getValue()];
    }

    // Prefix logic: Join remote name + path
    const prefix =
      remote?.fs_type === 'remote'
        ? this.pathSelectionService.normalizeRemoteForRclone(remote.name)
        : remote?.name; // For local, name is the root (C: or /)

    const fullPaths = paths.map(p => {
      // Handle root path logic carefully
      if (remote?.fs_type === 'local') {
        // Avoid double slashes if root is "/"
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

  // --- CONTEXT MENUS & HELPERS ---

  onItemContextMenu(event: MouseEvent, item: Entry): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuItem = item;
    this.contextMenuX.set(event.clientX);
    this.contextMenuY.set(event.clientY);
    this.contextMenuVisible.set(true);
  }

  onBackgroundContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuItem = null;
    this.contextMenuX.set(event.clientX);
    this.contextMenuY.set(event.clientY);
    this.contextMenuVisible.set(true);
  }

  onRemoteContextMenu(event: MouseEvent, remote: ExplorerRoot): void {
    event.preventDefault();
    event.stopPropagation();
    this.sideContextRemote.set(remote);
    this.sideContextX.set(event.clientX);
    this.sideContextY.set(event.clientY);
    this.sideContextVisible.set(true);
    this.contextMenuVisible.set(false);
  }

  openContextMenuOpen(): void {
    if (this.contextMenuItem) {
      this.navigateTo(this.contextMenuItem as NautilusEntry);
    }
    this.contextMenuVisible.set(false);
  }

  openContextMenuOpenInNewTab(): void {
    if (this.contextMenuItem?.IsDir) {
      this.createTab(this.nautilusRemote.getValue(), this.contextMenuItem.Path);
    }
    this.contextMenuVisible.set(false);
  }

  openContextMenuCopyPath(): void {
    if (!this.contextMenuItem) return;
    const remote = this.nautilusRemote.getValue();
    const prefix = remote?.name;
    const full =
      remote?.fs_type === 'remote'
        ? `${prefix}:${this.contextMenuItem.Path}`
        : `${prefix}/${this.contextMenuItem.Path}`;
    navigator.clipboard?.writeText(full);
    this.contextMenuVisible.set(false);
  }

  openContextMenuSelectToggle(): void {
    if (this.contextMenuItem) {
      const sel = new Set(this.selectedItems.getValue());
      if (sel.has(this.contextMenuItem.Path)) {
        sel.delete(this.contextMenuItem.Path);
      } else {
        sel.add(this.contextMenuItem.Path);
      }
      this.selectedItems.next(sel);
      this.tabs[this.activeTabIndex()].selection = sel;
      this.updateSelectionSummary();
    }
    this.contextMenuVisible.set(false);
  }

  openContextMenuProperties(): void {
    this.dialog.open(PropertiesModalComponent, {
      data: {
        remoteName: this.nautilusRemote.getValue()?.name,
        path: this.contextMenuItem?.Path || this.currentPath.getValue(),
        fs_type: this.nautilusRemote.getValue()?.fs_type,
        item: this.contextMenuItem,
      },
    });
    this.contextMenuVisible.set(false);
  }

  async openContextMenuNewFolder(): Promise<void> {
    const remote = this.nautilusRemote.getValue();
    if (!remote) {
      this.contextMenuVisible.set(false);
      return;
    }

    let normalized = remote.name;
    if (remote.fs_type === 'remote') {
      normalized = this.pathSelectionService.normalizeRemoteForRclone(remote.name);
    }

    const current = this.currentPath.getValue();
    const existingNames = (this.files() || []).map(f => f.Name);

    const ref = this.dialog.open(InputModalComponent, {
      data: {
        title: 'New Folder',
        label: 'Folder name',
        icon: 'folder',
        placeholder: 'Enter folder name',
        existingNames,
      },
      disableClose: true,
    });

    try {
      const folderName = await firstValueFrom(ref.afterClosed());
      if (!folderName) {
        this.contextMenuVisible.set(false);
        return;
      }

      const sep =
        remote.fs_type === 'local' && (current === '' || current.endsWith('/')) ? '' : '/';
      const newPath = current ? `${current}${sep}${folderName}` : folderName;

      await this.remoteManagement.makeDirectory(normalized, newPath);
      this.refresh();
    } catch (e) {
      console.error('Failed to create folder', e);
      this.notificationService.showError('Failed to create folder');
    }
    this.contextMenuVisible.set(false);
  }

  async openRemoteAboutFromSidebar(): Promise<void> {
    const r = this.sideContextRemote();
    if (!r) return;

    // For remote types, normalized name includes colon. For local, it's just the path.
    const normalized =
      r.fs_type === 'remote' ? this.pathSelectionService.normalizeRemoteForRclone(r.name) : r.name;

    this.dialog.open(RemoteAboutModalComponent, {
      data: { remote: { displayName: r.name, normalizedName: normalized, type: r.type } },
      ...STANDARD_MODAL_SIZE,
    });
    this.sideContextVisible.set(false);
  }

  async openSidebarCleanup(): Promise<void> {
    const r = this.sideContextRemote();
    if (!r) return;

    const confirmed = await this.notificationService.confirmModal(
      'Empty Trash',
      `This will remove trashed files from ${r.name}. Continue?`,
      'Empty Trash',
      'Cancel'
    );

    if (!confirmed) {
      this.sideContextVisible.set(false);
      return;
    }

    try {
      const normalized =
        r.fs_type === 'remote'
          ? this.pathSelectionService.normalizeRemoteForRclone(r.name)
          : r.name;
      await this.remoteManagement.cleanup(normalized);
      this.notificationService.showSuccess('Trash emptied successfully');
    } catch (e) {
      console.error('Failed to empty trash', e);
      this.notificationService.showError('Failed to empty trash: ' + (e as Error).message);
    }
    this.sideContextVisible.set(false);
  }

  // --- SETTINGS & HELPERS ---

  toggleStar(item: NautilusEntry): void {
    const remote = item._nautilusRemote || this.nautilusRemote.getValue()?.name;
    if (!remote) return;
    // Delegate to NautilusService which centralizes persistence and state
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _nautilusRemote, ...entry } = item;
    this.nautilusService.toggleStar(remote, entry as Entry);
  }

  isStarred(item: NautilusEntry): boolean {
    const remote = item._nautilusRemote || this.nautilusRemote.getValue()?.name;
    if (!remote) return false;
    return this.nautilusService.isStarred(remote, item.Path);
  }

  // formatStarKey removed; starred items are managed by NautilusService

  updateSelectionSummary(): void {
    const c = this.selectedItems.getValue().size;
    this.selectionSummary.set(c > 0 ? `${c} selected` : '');
  }

  updateHistoryButtons(): void {
    const tab = this.tabs[this.activeTabIndex()];
    this.canGoBack.set(tab.historyIndex > 0);
    this.canGoForward.set(tab.historyIndex < tab.history.length - 1);
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

  // --- ICON & LAYOUT CONTROLS ---

  increaseIconSize(): void {
    const layout = this.layout();
    const sizes = layout === 'list' ? this.LIST_ICON_SIZES : this.GRID_ICON_SIZES;
    const cur = this.iconSize();
    let idx = sizes.findIndex(s => s === cur);
    if (idx === -1) {
      idx = sizes.findIndex(s => s > cur);
      if (idx === -1) idx = sizes.length - 1;
    }
    const next = Math.min(sizes.length - 1, idx + 1);
    this.iconSize.set(sizes[next]);
    this.saveIconSize();
  }

  decreaseIconSize(): void {
    const layout = this.layout();
    const sizes = layout === 'list' ? this.LIST_ICON_SIZES : this.GRID_ICON_SIZES;
    const cur = this.iconSize();
    let idx = sizes.findIndex(s => s === cur);
    if (idx === -1) {
      idx =
        sizes
          .map((v, i) => ({ v, i }))
          .reverse()
          .find(x => x.v < cur)?.i ?? 0;
    }
    const prev = Math.max(0, idx - 1);
    this.iconSize.set(sizes[prev]);
    this.saveIconSize();
  }

  increaseIconDisabled(): boolean {
    const sizes = this.layout() === 'list' ? this.LIST_ICON_SIZES : this.GRID_ICON_SIZES;
    return this.iconSize() >= sizes[sizes.length - 1];
  }

  decreaseIconDisabled(): boolean {
    const sizes = this.layout() === 'list' ? this.LIST_ICON_SIZES : this.GRID_ICON_SIZES;
    return this.iconSize() <= sizes[0];
  }

  saveIconSize(): void {
    const key = this.layout() === 'list' ? 'list_icon_size' : 'grid_icon_size';
    this.appSettingsService.saveSetting('nautilus', key, this.iconSize());
  }

  setLayout(l: 'grid' | 'list'): void {
    this.layout.set(l);
    // Snap to nearest valid size for new layout
    const sizes = l === 'list' ? this.LIST_ICON_SIZES : this.GRID_ICON_SIZES;
    const cur = this.iconSize();
    let nearest = sizes[0];
    let bestDiff = Math.abs(cur - nearest);
    for (const s of sizes) {
      const d = Math.abs(cur - s);
      if (d < bestDiff) {
        bestDiff = d;
        nearest = s;
      }
    }
    this.iconSize.set(nearest);
    this.appSettingsService.saveSetting('nautilus', 'default_layout', l);
  }

  setSort(k: string): void {
    this.sortKey.set(k);
    this.appSettingsService.saveSetting('nautilus', 'sort_key', k);
    this.refresh();
  }

  toggleShowHidden(v: boolean): void {
    this.showHidden.set(v);
    this.appSettingsService.saveSetting('nautilus', 'show_hidden_by_default', v);
  }

  selectStarred(): void {
    // If already in starred mode, do nothing (act like a normal selection)
    if (this.starredMode()) return;
    this.starredMode.set(true);
    // Clear the active remote and path since we are now in the virtual "Starred" view
    this.nautilusRemote.next(null);
    this.currentPath.next('');
    // Clear any previous file selections
    this.selectedItems.next(new Set());
    this.updateSelectionSummary();
  }

  onPathScroll(e: WheelEvent): void {
    (e.currentTarget as HTMLElement).scrollBy(e.deltaY, 0);
  }

  clearSelection(): void {
    this.selectedItems.next(new Set());
    this.tabs[this.activeTabIndex()].selection = new Set();
    this.updateSelectionSummary();
  }

  cancelLoad(): void {
    this.isLoading.set(false);
  }
  async runBackgroundCleanupChecks(remotes: ExplorerRoot[]): Promise<void> {
    this.cleanupSupportCache.update(c => {
      const u: Record<string, boolean> = {};
      remotes.forEach(r => (u[r.name] = false));
      return { ...c, ...u };
    });

    for (const r of remotes) {
      try {
        // Only remote type supports cleanup check via 'getFsInfo'
        if (r.fs_type !== 'remote') continue;

        const normalized = this.pathSelectionService.normalizeRemoteForRclone(r.name);
        const info = (await this.remoteManagement
          .getFsInfo(normalized)
          .catch(() => null)) as FsInfo | null;
        if (info?.Features?.CleanUp) {
          this.cleanupSupportCache.update(c => ({ ...c, [r.name]: true }));
        }
      } catch (e) {
        console.error('Error during background cleanup checks', e);
      }
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      // Run fetches in parallel so one missing setting doesn't block the others
      const [layout, sortKey, showHidden] = await Promise.all([
        this.appSettingsService.getSettingValue<'grid' | 'list'>('nautilus.default_layout'),
        this.appSettingsService.getSettingValue<string>('nautilus.sort_key'),
        this.appSettingsService.getSettingValue<boolean>('nautilus.show_hidden_by_default'),
      ]);

      if (layout) this.layout.set(layout);
      if (sortKey) this.sortKey.set(sortKey);
      if (typeof showHidden === 'boolean') this.showHidden.set(showHidden);

      // Starred items are loaded centrally by NautilusService; component
      // will sync via the service's signal.
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
  trackBySortOption(i: number, o: { key: string; label: string }): string {
    return o.key;
  }
  trackByTab(i: number, t: { id: number }): number {
    return t.id;
  }

  private _globalClickListener = (): void => {
    if (this.contextMenuVisible()) this.contextMenuVisible.set(false);
    if (this.sideContextVisible()) this.sideContextVisible.set(false);
  };
  private _globalEscapeHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // 1. Close Menu if open
      if (this.viewMenuTrigger && this.viewMenuTrigger.menuOpen) return;

      // 2. Close Context Menus
      if (this.contextMenuVisible() || this.sideContextVisible()) {
        this._globalClickListener();
        e.stopImmediatePropagation();
        return;
      }

      // 3. Close File Picker
      this.onClose();
    }
  };
  @HostListener('window:resize') onResize(): void {
    this.isMobile.set(window.innerWidth < 680);
  }
}

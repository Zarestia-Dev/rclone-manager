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
} from '@angular/core';
import { toSignal, toObservable, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BehaviorSubject, combineLatest, from, of } from 'rxjs';
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
import { AnimationsService } from '../../shared/services/animations.service';
import {
  UiStateService,
  NautilusService,
  RemoteManagementService,
  MountManagementService,
  FilePickerOptions,
} from '@app/services';
import { Entry } from '@app/types';
import { IconService } from '../../shared/services/icon.service';
import { LocalDrive } from '@app/types';
// invoke removed (search removed)
import { PropertiesModalComponent } from '../modals/properties/properties-modal.component';
import { FileViewerService } from '../../services/ui/file-viewer.service';

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
  ],
  templateUrl: './nautilus.component.html',
  styleUrl: './nautilus.component.scss',
  animations: [AnimationsService.slideOverlay()],
})
export class NautilusComponent implements OnInit, OnDestroy {
  // Tab model counter
  interfaceTabCounter = 0;
  @ViewChild('pathScrollView') pathScrollView?: ElementRef<HTMLDivElement>;

  // Per-tab state
  tabs: {
    id: number;
    title: string;
    remote: { name: string; type?: string } | null;
    path: string;
    selection: Set<string>;
    history: { remote: { name: string; type?: string } | null; path: string }[];
    historyIndex: number;
  }[] = [];
  public activeTabIndex = signal(0);

  // Context menu state
  public contextMenuVisible = signal(false);
  public contextMenuX = signal(0);
  public contextMenuY = signal(0);
  public contextMenuItem: Entry | null = null;
  // Sidebar (remotes) context menu state
  public sideContextVisible = signal(false);
  public sideContextX = signal(0);
  public sideContextY = signal(0);
  public sideContextRemote: { name: string; type?: string } | null = null;
  // Services
  private uiStateService = inject(UiStateService);
  private nautilusService = inject(NautilusService);
  private remoteManagement = inject(RemoteManagementService);
  private mountManagement = inject(MountManagementService);
  public iconService = inject(IconService);
  private fileViewerService = inject(FileViewerService);
  private dialog = inject(MatDialog);

  // Signals & State
  // Search removed temporarily (UI disabled). Per-tab history used instead.

  public isLoading = signal(false);
  public canGoBack = signal(false);
  public canGoForward = signal(false);
  public isPickerMode = signal(false);
  public pickerOptions = signal<FilePickerOptions>({});
  public title = signal('Files');

  public layout = signal<'grid' | 'list'>('grid');
  public sortKey = signal<string>('name');
  public sortDirection = signal<'asc' | 'desc'>('asc');
  public showHidden = signal(false);
  public iconSize = signal(120);

  // Navigation State
  public nautilusRemote = new BehaviorSubject<{ name: string; type?: string } | null>(null);
  public currentPath = new BehaviorSubject<string>('');

  // Selection
  public selectedItems = new BehaviorSubject<Set<string>>(new Set());
  public selectionSummary = signal('');
  private lastSelectedIndex: number | null = null;

  public isEditingPath = signal(false);

  // Derived Data Sources
  public remotes$ = this.remoteManagement.remotes$;
  public mountedRemotes$ = this.mountManagement.mountedRemotes$;
  private remoteConfigs$ = new BehaviorSubject<Record<string, unknown>>({});

  // Access the sidenav to toggle it programmatically
  @ViewChild('sidenav') sidenav!: MatSidenav;

  // Responsive State
  public isMobile = signal(window.innerWidth < 680);

  public sidenavMode = computed(() => (this.isMobile() ? 'over' : 'side'));
  public isSidenavOpen = signal(!this.isMobile());

  @HostListener('window:resize')
  onResize(): void {
    const mobile = window.innerWidth < 680;
    // Only update if state changed to prevent unnecessary cycles
    if (this.isMobile() !== mobile) {
      this.isMobile.set(mobile);
      // If switching to desktop, ensure sidebar is open. If mobile, default closed.
      this.isSidenavOpen.set(!mobile);
    }
  }

  // Combined Remotes List
  public remotesWithMeta = toSignal(
    combineLatest([
      this.remotes$,
      this.remoteConfigs$,
      this.mountedRemotes$,
      from(this.remoteManagement.getLocalDrives()),
    ]).pipe(
      map(([names, configs, mountedRemotes, localDrives]) => {
        const remoteList = (names || []).map(name => {
          const mountedInfo = mountedRemotes.find(mr => mr.fs.replace(/:$/, '') === name);
          return {
            name,
            label: name,
            type: (configs?.[name] as any)?.type || (configs?.[name] as any)?.Type,
            isMounted: !!mountedInfo,
            mountPoint: mountedInfo?.mount_point,
          };
        });

        const localDrivesList = localDrives.map((drive: LocalDrive) => ({
          name: drive.name,
          label: drive.name !== 'Local' ? `${drive.label} (${drive.name})` : drive.label,
          type: 'home',
          isMounted: false,
          mountPoint: undefined,
        }));

        return [...localDrivesList, ...remoteList];
      })
    ),
    { initialValue: [] }
  );

  // Filtered remotes based on restrictSingle
  public filteredRemotes = computed(() => {
    const allRemotes = this.remotesWithMeta();
    const restrict = this.pickerOptions().restrictSingle;
    if (restrict) {
      return allRemotes.filter(r => r.name === restrict);
    }
    return allRemotes;
  });

  public pathSegments = toSignal(
    this.currentPath.pipe(map(path => path.split('/').filter(p => p))),
    { initialValue: [] }
  );

  // --- PATH INPUT LOGIC ---

  // Signals to feed the fullPathInput computed
  public activeRemoteSig = toSignal(this.nautilusRemote, { initialValue: null });
  public activePathSig = toSignal(this.currentPath, { initialValue: '' });

  public fullPathInput = computed(() => {
    const remote = this.activeRemoteSig();
    const path = this.activePathSig() || '';

    if (!remote) return path;

    // 1. Local Filesystem (Unix/Root)
    // If it's "Local", users expect paths to start with / (e.g. /etc, /home)
    if (remote.name === 'Local') {
      return path.startsWith('/') ? path : `/${path}`;
    }

    // 2. Windows Drive or Remotes that might already be named like "C:"
    if (remote.name.endsWith(':')) {
      // Avoid double slashes if path is empty or starts with slash
      const cleanPath = path.startsWith('/') ? path : `/${path}`;
      // e.g. "C:/Users" or "C:/"
      return `${remote.name}${cleanPath}`;
    }

    // 3. Named Remote (e.g. "gdrive")
    // Needs colon appended for valid rclone syntax: "gdrive:/path"
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${remote.name}:${cleanPath}`;
  });

  // --- MAIN FILE DATA PIPELINE ---

  // Combined Options Signal -> Observable
  // This fixes the issue of mixing signals/observables in combineLatest directly
  private options$ = toObservable(
    computed(() => ({
      sortKey: this.sortKey(),
      sortDirection: this.sortDirection(),
      showHidden: this.showHidden(),
    }))
  );

  // 1. Standard Browse Stream
  private browseFiles$ = combineLatest([this.nautilusRemote, this.currentPath]).pipe(
    switchMap(([remote, path]) => {
      if (!remote?.name) {
        return of([]);
      }
      this.isLoading.set(true);
      const remoteName = remote.name === 'Local' ? '' : remote.name;

      return from(this.remoteManagement.getRemotePaths(remoteName, path, {})).pipe(
        map(res => res.list || []),
        catchError(err => {
          console.error('Error fetching files:', err);
          return of([]);
        }),
        // Emit an empty list immediately when navigation starts so the UI clears
        // (matches Nautilus behaviour: clear view while loading new directory)
        startWith([]),
        finalize(() => this.isLoading.set(false))
      );
    })
  );

  // 2. Search Stream
  // Search removed temporarily

  // 3. Merged & Filtered Output
  public files = toSignal(
    combineLatest([this.browseFiles$, this.options$]).pipe(
      map(([browseFiles, opts]) => {
        let resultFiles: Entry[] = browseFiles || [];

        // Filter Hidden
        if (!opts.showHidden) {
          resultFiles = resultFiles.filter(f => !f.Name.startsWith('.'));
        }

        // Sort
        const getRank = (item: Entry) => {
          const isHidden = item.Name.startsWith('.');
          if (item.IsDir) {
            return isHidden ? 2 : 1;
          }
          return isHidden ? 4 : 3;
        };

        return resultFiles.sort((a, b) => {
          const rankA = getRank(a);
          const rankB = getRank(b);

          if (rankA !== rankB) {
            return rankA - rankB;
          }

          // If ranks are the same, fall back to user-selected sort
          const dir = opts.sortDirection === 'asc' ? 1 : -1;

          switch (opts.sortKey) {
            case 'name':
              return a.Name.localeCompare(b.Name) * dir;
            case 'modified':
              return (new Date(a.ModTime).getTime() - new Date(b.ModTime).getTime()) * dir;
            case 'size':
              return (a.Size - b.Size) * dir;
            default:
              return 0;
          }
        });
      })
    ),
    { initialValue: [] as Entry[] }
  );

  @Output() closeOverlay = new EventEmitter<void>();
  @ViewChild('pathInput') pathInput?: ElementRef<HTMLInputElement>;

  // Access to Material Menu Trigger to check if a menu is open
  @ViewChild(MatMenuTrigger) viewMenuTrigger?: MatMenuTrigger;

  private _globalClickListener = (): void => {
    if (this.contextMenuVisible()) this.contextMenuVisible.set(false);
    if (this.sideContextVisible()) this.sideContextVisible.set(false);
  };

  // Capture-phase handler for Escape key
  private _globalEscapeHandler = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      // 1. If a Material Menu is open on top, let Material handle it (it consumes Escape)
      // We don't want to close Nautilus while a view menu is open.
      if (this.viewMenuTrigger && this.viewMenuTrigger.menuOpen) {
        return;
      }

      // 2. If Custom Context Menus are open, close them and stop propagation
      if (this.contextMenuVisible()) {
        this.contextMenuVisible.set(false);
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }

      if (this.sideContextVisible()) {
        this.sideContextVisible.set(false);
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }

      // 3. Close Nautilus Overlay
      // Stop propagation so underlying modals don't receive the Escape event
      this.nautilusService.closeFilePicker(null);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
  };

  constructor() {
    this.nautilusService.filePickerState$.pipe(takeUntilDestroyed()).subscribe(state => {
      this.isPickerMode.set(state.isOpen);
      if (state.isOpen && state.options) {
        this.pickerOptions.set(state.options);
        this.title.set(state.options.selectFolders ? 'Select Folder' : 'Select Files');
      } else {
        this.title.set('Files');
      }
    });

    effect(() => {
      this.pathSegments(); // Dependency trigger
      setTimeout(() => {
        if (this.pathScrollView?.nativeElement) {
          const el = this.pathScrollView.nativeElement;
          el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
        }
      }, 50); // Small delay to allow DOM rendering
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.remoteManagement.getRemotes();
      await this.mountManagement.getMountedRemotes();
      try {
        const configs = await this.remoteManagement.getAllRemoteConfigs();
        this.remoteConfigs$.next(configs || {});
      } catch (e) {
        console.warn('No remote configs', e);
      }

      // Initialize selection from UiStateService (OBSERVABLE)
      this.uiStateService.selectedRemote$.pipe(take(1)).subscribe(async currentSelected => {
        let initialRemote = null;
        if (currentSelected) {
          initialRemote = currentSelected.remoteSpecs;
        } else {
          const drives = await this.remoteManagement.getLocalDrives();
          if (drives.length > 0) {
            initialRemote = { name: drives[0].name, type: 'home' };
          } else {
            initialRemote = { name: 'Local', type: 'home' };
          }
        }

        // create the first tab
        this.createTab(initialRemote, '');
      });

      // Hide context menu on global clicks
      window.addEventListener('click', this._globalClickListener);

      // Add capture-phase listener for Escape key
      window.addEventListener('keydown', this._globalEscapeHandler, true);
    } catch (err) {
      console.warn('Failed to init nautilus', err);
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('click', this._globalClickListener);
    window.removeEventListener('keydown', this._globalEscapeHandler, true);
  }

  // --- Actions ---

  confirmSelection(): void {
    let selectedPaths = Array.from(this.selectedItems.getValue());
    const remote = this.nautilusRemote.getValue();

    if (selectedPaths.length === 0 && this.pickerOptions().selectFolders) {
      selectedPaths = [this.currentPath.getValue()];
    }

    const prefix = remote && remote.name !== 'Local' ? `${remote.name}:` : '';
    const fullPaths = selectedPaths.map(path => `${prefix}${path}`);

    this.nautilusService.closeFilePicker(fullPaths);
  }

  // Search UI & handlers removed

  onItemClick(item: Entry, event: MouseEvent, index: number): void {
    event.stopPropagation();
    if (this.isPickerMode() && !this.isItemSelectable(item)) return;

    const currentSelection = new Set(this.selectedItems.getValue());
    const multiSelect = !this.isPickerMode() || this.pickerOptions().multiSelection !== false;

    if (event.shiftKey && this.lastSelectedIndex !== null && multiSelect) {
      currentSelection.clear();
      const start = Math.min(this.lastSelectedIndex, index);
      const end = Math.max(this.lastSelectedIndex, index);
      for (let i = start; i <= end; i++) {
        currentSelection.add(item.Path);
      }
    } else if (event.ctrlKey && multiSelect) {
      if (currentSelection.has(item.Path)) currentSelection.delete(item.Path);
      else currentSelection.add(item.Path);
      this.lastSelectedIndex = index;
    } else {
      currentSelection.clear();
      currentSelection.add(item.Path);
      this.lastSelectedIndex = index;
    }

    this.selectedItems.next(currentSelection);
    // persist selection to active tab
    const tab = this.tabs[this.activeTabIndex()];
    if (tab) tab.selection = new Set(currentSelection);
    this.updateSelectionSummary();
  }

  // Right click handler for items
  onItemContextMenu(event: MouseEvent, item: Entry): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuItem = item;
    this.contextMenuX.set(event.clientX);
    this.contextMenuY.set(event.clientY);
    this.contextMenuVisible.set(true);
  }

  unmount(mountPoint: string, remoteName: string): void {
    this.mountManagement.unmountRemote(mountPoint, remoteName).then(() => {
      this.mountManagement.getMountedRemotes();
    });
  }

  private updateSelectionSummary(): void {
    const count = this.selectedItems.getValue().size;
    this.selectionSummary.set(count > 0 ? `${count} items selected` : '');
  }

  isItemSelectable(item: Entry): boolean {
    if (!this.isPickerMode()) return true;
    const opts = this.pickerOptions();
    if (opts.selectFolders && !item.IsDir) return false;
    if (opts.selectFiles && item.IsDir) return false;
    return true;
  }

  changeSort(key: string): void {
    if (this.sortKey() === key) {
      this.sortDirection.set(this.sortDirection() === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortKey.set(key);
      this.sortDirection.set('asc');
    }
  }

  setLayout(l: 'grid' | 'list'): void {
    this.layout.set(l);
  }
  toggleShowHidden(v: boolean): void {
    this.showHidden.set(v);
  }
  increaseIconSize(): void {
    this.iconSize.update(s => Math.min(s + 20, 240));
  }
  decreaseIconSize(): void {
    this.iconSize.update(s => Math.max(s - 20, 80));
  }

  // Navigation
  goBack(): void {
    const tab = this.tabs[this.activeTabIndex()];
    if (tab && tab.historyIndex > 0) {
      tab.historyIndex--;
      const historyEntry = tab.history[tab.historyIndex];
      this._navigate(historyEntry.remote, historyEntry.path, false);
    }
  }
  goForward(): void {
    const tab = this.tabs[this.activeTabIndex()];
    if (tab && tab.historyIndex < tab.history.length - 1) {
      tab.historyIndex++;
      const historyEntry = tab.history[tab.historyIndex];
      this._navigate(historyEntry.remote, historyEntry.path, false);
    }
  }

  navigateTo(item: Entry): void {
    if (item.IsDir) this.updatePath(item.Path);
  }

  updatePath(newPath: string): void {
    const remote = this.nautilusRemote.getValue();
    this._navigate(remote, newPath, true);
  }

  selectRemote(remote: { name: string; type?: string } | null): void {
    const remoteName = remote?.name || 'Local';
    this._navigate(remote, remoteName.endsWith(':') ? '/' : '', true);
  }

  // Parses the user's typed path from the input box
  navigateToPath(rawInput: string): void {
    this.isEditingPath.set(false);

    // Normalize slashes
    const normalized = rawInput.replace(/\\/g, '/');

    let remoteName = 'Local';
    let path = normalized;

    // Detect Remote Syntax (e.g. "gdrive:/folder" or "C:/folder")
    const colonIndex = normalized.indexOf(':');

    if (colonIndex > -1) {
      // It has a colon, so it's likely a remote or drive letter
      const prefix = normalized.substring(0, colonIndex);
      const suffix = normalized.substring(colonIndex + 1);

      // Try to find a matching remote in our known list
      const knownRemotes = this.remotesWithMeta();
      // Check for exact match "gdrive" or "C:"
      const match = knownRemotes.find(r => r.name === prefix || r.name === `${prefix}:`);

      if (match) {
        remoteName = match.name;
        path = suffix;
      } else {
        // Fallback: If it looks like a drive letter "C" from "C:/", treat as "C:"
        if (prefix.length === 1 && /[a-zA-Z]/.test(prefix)) {
          remoteName = `${prefix}:`;
          path = suffix;
        } else {
          // Unknown remote, try to use it as a remote anyway (Rclone can handle it if it exists)
          remoteName = prefix;
          path = suffix;
        }
      }
    } else {
      // No colon
      if (normalized.startsWith('/')) {
        // Absolute path start -> Local
        remoteName = 'Local';
        // path is already correct
      } else {
        // Relative path -> Keep current remote
        const current = this.nautilusRemote.getValue();
        if (current) remoteName = current.name;
      }
    }

    // Strip leading slash for internal path consistency (unless it's truly root, handled by empty string)
    // Rclone generally expects paths without leading slash relative to the remote root
    if (path.startsWith('/')) {
      path = path.substring(1);
    }

    // Determine type for new remote object if we are switching
    let type = 'unknown';
    const known = this.remotesWithMeta().find(r => r.name === remoteName);
    if (known) type = known.type;
    else if (remoteName === 'Local') type = 'home';

    const newRemote = { name: remoteName, type };
    this._navigate(newRemote, path, true);
  }

  navigateToSegment(index: number): void {
    const segments = this.pathSegments();
    const newPath = segments.slice(0, index + 1).join('/');
    this.updatePath(newPath);
  }

  formatBytes(b: number): string {
    const i = b === 0 ? 0 : Math.floor(Math.log(b) / Math.log(1024));
    return +(b / Math.pow(1024, i)).toFixed(2) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
  }

  formatRelativeDate(d: string): string {
    return new Date(d).toLocaleDateString();
  }

  clearSelection(): void {
    const newSel = new Set<string>();
    this.selectedItems.next(newSel);
    this.selectionSummary.set('');
    const tab = this.tabs[this.activeTabIndex()];
    if (tab) tab.selection = newSel;
  }
  onClose(): void {
    this.nautilusService.closeFilePicker(null);
  }
  cancelLoad(): void {
    this.isLoading.set(false);
  }

  // Tab management
  createTab(remote: { name: string; type?: string } | null, path = ''): void {
    const id = ++this.interfaceTabCounter;
    const t = {
      id,
      title: remote?.name || 'Local',
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

  closeTab(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    this.tabs.splice(index, 1);
    let newIndex = this.activeTabIndex();
    if (index <= newIndex) newIndex = Math.max(0, newIndex - 1);
    if (this.tabs.length === 0) {
      // create a fresh empty tab
      this.createTab({ name: 'Local', type: 'home' }, '');
      return;
    }
    this.activeTabIndex.set(newIndex);
    const active = this.tabs[newIndex];
    this.nautilusRemote.next(active.remote);
    this.currentPath.next(active.path);
    this.selectedItems.next(new Set(active.selection));
    this.updateSelectionSummary();
    this.updateHistoryButtonsState();
  }

  switchTab(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    this.activeTabIndex.set(index);
    const active = this.tabs[index];
    this.nautilusRemote.next(active.remote);
    this.currentPath.next(active.path);
    this.selectedItems.next(new Set(active.selection));
    this.updateSelectionSummary();
    this.updateHistoryButtonsState();
  }

  // Context menu actions
  openContextMenuOpen(): void {
    const item = this.contextMenuItem;
    if (!item) return;
    if (item.IsDir) {
      // navigate into folder in active tab
      this.updatePath(item.Path);
    } else {
      this.openFilePreview(item);
    }
    this.contextMenuVisible.set(false);
  }

  async openFilePreview(item: Entry): Promise<void> {
    const remote = this.nautilusRemote.getValue();
    if (!remote) return;
    this.fileViewerService.open(item, remote.name);
  }

  openContextMenuOpenInNewTab(): void {
    const item = this.contextMenuItem;
    if (!item) return;
    if (item.IsDir) {
      const activeRemote = this.nautilusRemote.getValue();
      this.createTab(activeRemote, item.Path);
    }
    this.contextMenuVisible.set(false);
  }

  openContextMenuCopyPath(): void {
    const item = this.contextMenuItem;
    if (!item) return;
    const remote = this.nautilusRemote.getValue();
    if (!remote) return;

    let fullPath: string;
    if (remote.name === 'Local') {
      fullPath = `/${item.Path}`;
    } else {
      fullPath = `${remote.name}:/${item.Path}`;
    }

    try {
      // fallback to navigator clipboard when available
      navigator.clipboard?.writeText(fullPath);
    } catch (e) {
      console.warn('Copy failed', e);
    }
    this.contextMenuVisible.set(false);
  }

  openContextMenuSelectToggle(): void {
    const item = this.contextMenuItem;
    if (!item) return;
    const sel = new Set(this.selectedItems.getValue());
    if (sel.has(item.Path)) sel.delete(item.Path);
    else sel.add(item.Path);
    this.selectedItems.next(sel);
    const tab = this.tabs[this.activeTabIndex()];
    if (tab) tab.selection = new Set(sel);
    this.updateSelectionSummary();
    this.contextMenuVisible.set(false);
  }

  openContextMenuProperties(): void {
    const item = this.contextMenuItem;
    if (!item) return;
    const remote = this.nautilusRemote.getValue();
    if (!remote) return;
    this.dialog.open(PropertiesModalComponent, {
      data: { remoteName: remote.name, path: item.Path },
    });
    this.contextMenuVisible.set(false);
  }

  // Remote (sidebar) context menu
  onRemoteContextMenu(event: MouseEvent, remote: { name: string; type?: string } | null): void {
    event.preventDefault();
    event.stopPropagation();
    this.sideContextRemote = remote;
    this.sideContextX.set(event.clientX);
    this.sideContextY.set(event.clientY);
    this.sideContextVisible.set(true);
    // hide file context menu if open
    if (this.contextMenuVisible()) this.contextMenuVisible.set(false);
  }

  async openRemoteAboutFromSidebar(): Promise<void> {
    const remote = this.sideContextRemote;
    if (!remote) return;

    this.dialog.open(
      (await import('../modals/remote/remote-about-modal.component')).RemoteAboutModalComponent,
      {
        data: { remote },
        disableClose: false,
      }
    );
  }

  private _navigate(
    remote: { name: string; type?: string } | null,
    path: string,
    newHistoryEntry: boolean
  ): void {
    const tab = this.tabs[this.activeTabIndex()];
    if (!tab) return;

    if (newHistoryEntry) {
      if (tab.historyIndex < tab.history.length - 1) {
        tab.history.splice(tab.historyIndex + 1);
      }
      tab.history.push({ remote, path });
      tab.historyIndex++;
    }

    tab.remote = remote;
    tab.path = path;
    tab.title =
      path === '' || path === '/' ? remote?.name || 'Local' : `${remote?.name || 'Local'}:${path}`;

    this.nautilusRemote.next(remote);
    this.currentPath.next(path);

    tab.selection.clear();
    this.selectedItems.next(tab.selection);
    this.updateSelectionSummary();

    this.updateHistoryButtonsState();
  }

  private updateHistoryButtonsState(): void {
    const tab = this.tabs[this.activeTabIndex()];
    if (tab) {
      this.canGoBack.set(tab.historyIndex > 0);
      this.canGoForward.set(tab.historyIndex < tab.history.length - 1);
    } else {
      this.canGoBack.set(false);
      this.canGoForward.set(false);
    }
  }

  getActiveRemote(): { name: string; type?: string } | null {
    return this.nautilusRemote.getValue();
  }

  // TrackBy for tabs
  trackByTab(i: number, t: { id: number }): number {
    return t.id;
  }

  // TrackBy
  trackByFile(i: number, item: Entry): string {
    return item.ID || item.Path;
  }
  trackByRemote(i: number, item: { name: string }): string {
    return item.name;
  }

  onPathScroll(event: WheelEvent) {
    const element = event.currentTarget as HTMLElement;
    element.scrollBy(event.deltaY, 0);
    event.preventDefault();
  }
}

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
} from '@angular/core';
import { toSignal, toObservable, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BehaviorSubject, combineLatest, from, of } from 'rxjs';
import { catchError, debounceTime, finalize, map, switchMap, take } from 'rxjs/operators';
import { CommonModule } from '@angular/common';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatButtonModule } from '@angular/material/button';
import { MatGridListModule } from '@angular/material/grid-list';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatDialog } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { FormsModule } from '@angular/forms';
import { AnimationsService } from '../../shared/services/animations.service';
import {
  UiStateService,
  WindowService,
  RemoteManagementService,
  MountManagementService,
  FilePickerOptions,
} from '@app/services';
import { Entry } from '@app/types';
import { IconService } from '../../shared/services/icon.service';
import { LocalDrive } from '@app/types';
import { invoke } from '@tauri-apps/api/core';
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

  // Per-tab state
  tabs: {
    id: number;
    title: string;
    remote: { name: string; type?: string } | null;
    path: string;
    selection: Set<string>;
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
  private windowService = inject(WindowService);
  private remoteManagement = inject(RemoteManagementService);
  private mountManagement = inject(MountManagementService);
  public iconService = inject(IconService);
  private fileViewerService = inject(FileViewerService);
  private dialog = inject(MatDialog);

  // Signals & State
  public isSearchEnabled = signal(false);
  public searchScope = signal<'global' | 'local'>('global');
  public searchQuery = signal<string>('');

  // Used to trigger strict RxJS stream for debounced searching
  private searchQuerySubject = new BehaviorSubject<string>('');

  public isLoading = signal(false);
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

  // History
  private pathHistory: string[] = [''];
  private currentHistoryIndex = 0;

  // Selection
  public selectedItems = new BehaviorSubject<Set<string>>(new Set());
  public selectionSummary = signal('');
  private lastSelectedIndex: number | null = null;

  public isEditingPath = signal(false);

  // Derived Data Sources
  public remotes$ = this.remoteManagement.remotes$;
  public mountedRemotes$ = this.mountManagement.mountedRemotes$;
  private remoteConfigs$ = new BehaviorSubject<Record<string, unknown>>({});

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
          label: `${drive.label} (${drive.name})`,
          type: 'home',
          isMounted: false,
          mountPoint: undefined,
        }));

        return [...localDrivesList, ...remoteList];
      })
    ),
    { initialValue: [] }
  );

  public pathSegments = toSignal(
    this.currentPath.pipe(map(path => path.split('/').filter(p => p))),
    { initialValue: [] }
  );

  // --- MAIN FILE DATA PIPELINE ---

  // Combined Options Signal -> Observable
  // This fixes the issue of mixing signals/observables in combineLatest directly
  private options$ = toObservable(
    computed(() => ({
      sortKey: this.sortKey(),
      sortDirection: this.sortDirection(),
      showHidden: this.showHidden(),
      searchScope: this.searchScope(),
      isSearchEnabled: this.isSearchEnabled(),
    }))
  );

  // 1. Standard Browse Stream
  private browseFiles$ = combineLatest([this.nautilusRemote, this.currentPath]).pipe(
    switchMap(([remote, path]) => {
      if (!remote?.name || (this.isSearchEnabled() && this.searchScope() === 'global')) {
        return of([]);
      }
      this.isLoading.set(true);
      const remoteName = remote.name === 'Local' ? '' : remote.name;

      return from(this.remoteManagement.getRemotePaths(remoteName, path, {})).pipe(
        map(res => res.list),
        catchError(err => {
          console.error('Error fetching files:', err);
          return of([]);
        }),
        finalize(() => this.isLoading.set(false))
      );
    })
  );

  // 2. Search Stream
  private searchFiles$ = combineLatest([
    this.nautilusRemote,
    this.searchQuerySubject.pipe(debounceTime(400)),
  ]).pipe(
    switchMap(([remote, query]) => {
      if (!remote?.name || !this.isSearchEnabled() || this.searchScope() !== 'global' || !query) {
        return of(null);
      }
      this.isLoading.set(true);
      const remoteName = remote.name === 'Local' ? '' : remote.name;

      return from(
        invoke<{ list: Entry[] }>('search_remote_files', {
          remote: remoteName,
          query: query,
        })
      ).pipe(
        map(res => {
          console.log('Search results:', res);

          return res.list;
        }),
        catchError(err => {
          console.error('Error searching files:', err);
          return of([]);
        }),
        finalize(() => this.isLoading.set(false))
      );
    })
  );

  // 3. Merged & Filtered Output
  public files = toSignal(
    combineLatest([
      this.browseFiles$,
      this.searchFiles$,
      this.searchQuerySubject,
      this.options$,
    ]).pipe(
      map(([browseFiles, searchResults, query, opts]) => {
        let resultFiles: Entry[] = [];

        if (opts.isSearchEnabled && opts.searchScope === 'global' && searchResults !== null) {
          // Global Search Mode
          resultFiles = searchResults;
        } else {
          // Browse Mode (with optional local filter)
          resultFiles = browseFiles;
          if (opts.isSearchEnabled && opts.searchScope === 'local' && query) {
            resultFiles = resultFiles.filter(f =>
              f.Name.toLowerCase().includes(query.toLowerCase())
            );
          }
        }

        // Filter Hidden
        if (!opts.showHidden) {
          resultFiles = resultFiles.filter(f => !f.Name.startsWith('.'));
        }

        // Sort
        return resultFiles.sort((a, b) => {
          if (a.IsDir && !b.IsDir) return -1;
          if (!a.IsDir && b.IsDir) return 1;
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

  windowButtons = true;

  private _globalClickListener = (): void => {
    if (this.contextMenuVisible()) this.contextMenuVisible.set(false);
    if (this.sideContextVisible()) this.sideContextVisible.set(false);
  };

  constructor() {
    this.uiStateService.filePickerState$.pipe(takeUntilDestroyed()).subscribe(state => {
      this.isPickerMode.set(state.isOpen);
      if (state.isOpen && state.options) {
        this.pickerOptions.set(state.options);
        this.title.set(state.options.selectFolders ? 'Select Folder' : 'Select Files');
      } else {
        this.title.set('Files');
      }
    });

    if (this.uiStateService.platform === 'macos' || this.uiStateService.platform === 'web') {
      this.windowButtons = false;
    }
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
    } catch (err) {
      console.warn('Failed to init nautilus', err);
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('click', this._globalClickListener);
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

    this.uiStateService.closeFilePicker(fullPaths);
  }

  onSearchQueryChange(query: string): void {
    this.searchQuery.set(query);
    this.searchQuerySubject.next(query);
  }

  toggleSearch(scope: 'global' | 'local'): void {
    if (this.isSearchEnabled() && this.searchScope() === scope) {
      // Toggle off if clicking same scope
      this.isSearchEnabled.set(false);
      this.onSearchQueryChange('');
    } else {
      this.isSearchEnabled.set(true);
      this.searchScope.set(scope);
      // If switching scopes, trigger search immediately if query exists
      this.searchQuerySubject.next(this.searchQuery());
    }
  }

  onItemClick(item: Entry, event: MouseEvent, index: number): void {
    event.stopPropagation();
    if (this.isPickerMode() && !this.isItemSelectable(item)) return;

    const currentSelection = new Set(this.selectedItems.getValue());
    const multiSelect = !this.isPickerMode() || this.pickerOptions().multiSelection !== false;
    const files = this.files();

    if (event.shiftKey && this.lastSelectedIndex !== null && multiSelect) {
      currentSelection.clear();
      const start = Math.min(this.lastSelectedIndex, index);
      const end = Math.max(this.lastSelectedIndex, index);
      for (let i = start; i <= end; i++) {
        currentSelection.add(files[i].Path);
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
    if (this.currentHistoryIndex > 0) {
      this.currentHistoryIndex--;
      this.currentPath.next(this.pathHistory[this.currentHistoryIndex]);
    }
  }
  goForward(): void {
    if (this.currentHistoryIndex < this.pathHistory.length - 1) {
      this.currentHistoryIndex++;
      this.currentPath.next(this.pathHistory[this.currentHistoryIndex]);
    }
  }

  navigateTo(item: Entry): void {
    if (item.IsDir) this.updatePath(item.Path);
  }

  updatePath(newPath: string): void {
    // update active tab's path and push to global subjects so file pipeline picks it up
    const idx = this.activeTabIndex();
    const tab = this.tabs[idx];
    if (tab) {
      tab.path = newPath;
      // update title based on path
      tab.title =
        newPath === '' || newPath === '/'
          ? tab.remote?.name || 'Local'
          : `${tab.remote?.name || 'Local'}:${newPath}`;
    }

    this.currentPath.next(newPath);
    this.pathHistory.push(newPath);
    this.currentHistoryIndex++;
    // clear selection for this tab
    const newSel = new Set<string>();
    this.selectedItems.next(newSel);
    if (tab) tab.selection = newSel;
  }

  selectRemote(remote: { name: string; type?: string } | null): void {
    // set for active tab and propagate
    const idx = this.activeTabIndex();
    const tab = this.tabs[idx];
    if (tab) {
      tab.remote = remote;
    }
    this.nautilusRemote.next(remote);
    const remoteName = remote?.name || 'Local';
    this.updatePath(remoteName.endsWith(':') ? '/' : '');
  }

  navigateToPath(p: string): void {
    this.isEditingPath.set(false);
    this.updatePath(p);
  }

  formatBytes(b: number): string {
    const i = b === 0 ? 0 : Math.floor(Math.log(b) / Math.log(1024));
    return +(b / Math.pow(1024, i)).toFixed(2) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
  }

  formatRelativeDate(d: string): string {
    return new Date(d).toLocaleDateString();
  }

  // Window controls
  minimizeWindow(): void {
    this.windowService.minimize();
  }
  maximizeWindow(): void {
    this.windowService.maximize();
  }
  closeWindow(): void {
    this.windowService.close();
  }

  clearSelection(): void {
    const newSel = new Set<string>();
    this.selectedItems.next(newSel);
    this.selectionSummary.set('');
    const tab = this.tabs[this.activeTabIndex()];
    if (tab) tab.selection = newSel;
  }
  onClose(): void {
    this.uiStateService.closeFilePicker(null);
  }
  cancelLoad(): void {
    this.isLoading.set(false);
  }

  // Tab management
  createTab(remote: { name: string; type?: string } | null, path = ''): void {
    const id = ++this.interfaceTabCounter;
    const t = { id, title: remote?.name || 'Local', remote, path, selection: new Set<string>() };
    this.tabs.push(t);
    this.activeTabIndex.set(this.tabs.length - 1);
    // propagate to pipeline
    this.nautilusRemote.next(remote);
    this.currentPath.next(path);
    // reset selection subjects to the tab's selection
    this.selectedItems.next(new Set(t.selection));
    this.updateSelectionSummary();
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
  }

  switchTab(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    this.activeTabIndex.set(index);
    const active = this.tabs[index];
    this.nautilusRemote.next(active.remote);
    this.currentPath.next(active.path);
    this.selectedItems.next(new Set(active.selection));
    this.updateSelectionSummary();
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
}

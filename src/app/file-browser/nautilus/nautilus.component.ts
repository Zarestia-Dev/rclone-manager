// Handles tabs, split-view navigation, and rich file operations.
import {
  Component,
  inject,
  OnInit,
  ViewChild,
  signal,
  computed,
  effect,
  untracked,
  DestroyRef,
  output,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { fromEvent } from 'rxjs';
import { map, startWith } from 'rxjs/operators';

import { MatIconModule } from '@angular/material/icon';
import { MatSidenav, MatSidenavModule } from '@angular/material/sidenav';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { CdkMenuModule } from '@angular/cdk/menu';

import { NautilusService, PathSelectionService, NotificationService } from '@app/services';
import { ExplorerRoot, FileBrowserItem, FilePickerConfig } from '@app/types';

import { FormatFileSizePipe } from '@app/pipes';
import { NautilusFileOperationsService } from 'src/app/services/ui/nautilus-file-operations.service';
import { NautilusDragDropService } from 'src/app/services/ui/nautilus-drag-drop.service';
import { NautilusSettingsService } from 'src/app/services/ui/nautilus-settings.service';
import { NautilusTabService, PaneViewModel } from 'src/app/services/ui/nautilus-tab.service';
import { NautilusActionsService } from 'src/app/services/ui/nautilus-actions.service';
import { CopyToClipboardDirective, NautilusKeyboardDirective } from '@app/directives';

import { NautilusSidebarComponent } from './sidebar/nautilus-sidebar.component';
import { NautilusToolbarComponent } from './toolbar/nautilus-toolbar.component';
import { NautilusTabsComponent } from './tabs/nautilus-tabs.component';
import { NautilusViewPaneComponent } from './view-pane/nautilus-view-pane.component';
import { NautilusBottomBarComponent } from './bottom-bar/nautilus-bottom-bar.component';

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
    CopyToClipboardDirective,
  ],
  providers: [
    FormatFileSizePipe,
    NautilusFileOperationsService,
    NautilusDragDropService,
    NautilusSettingsService,
    NautilusTabService,
    NautilusActionsService,
  ],
  hostDirectives: [NautilusKeyboardDirective],
  templateUrl: './nautilus.component.html',
  styleUrl: './nautilus.component.scss',
})
export class NautilusComponent implements OnInit {
  // ── Services ────────────────────────────────────────────────────────────────
  private readonly destroyRef = inject(DestroyRef);
  private readonly translate = inject(TranslateService);
  private readonly notificationService = inject(NotificationService);
  private readonly nautilusService = inject(NautilusService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly formatFileSizePipe = inject(FormatFileSizePipe);
  protected readonly fileOps = inject(NautilusFileOperationsService);
  protected readonly dragDrop = inject(NautilusDragDropService);
  protected readonly settings = inject(NautilusSettingsService);
  protected readonly tabSvc = inject(NautilusTabService);
  protected readonly actions = inject(NautilusActionsService);
  private readonly keyboard = inject(NautilusKeyboardDirective);

  // ── Outputs & ViewChild ──────────────────────────────────────────────────────
  public readonly closeOverlay = output<void>();
  @ViewChild('sidenav') sidenav!: MatSidenav;

  // ── Responsive layout ────────────────────────────────────────────────────────
  private readonly _windowWidth = toSignal(
    fromEvent(window, 'resize').pipe(
      map(() => window.innerWidth),
      startWith(window.innerWidth)
    ),
    { initialValue: window.innerWidth }
  );
  protected readonly isMobile = computed(() => this._windowWidth() < 680);
  protected readonly isSidenavOpen = signal(!this.isMobile());
  protected readonly sidenavMode = computed(() => (this.isMobile() ? 'over' : 'side'));

  // ── Settings aliases (keep template unchanged) ───────────────────────────────
  protected readonly layout = this.settings.layout;
  protected readonly showHidden = this.settings.showHidden;
  protected readonly iconSize = this.settings.iconSize;
  protected readonly listRowHeight = this.settings.listRowHeight;
  protected readonly sortKey = this.settings.sortKey;
  protected readonly sortDirection = this.settings.sortDirection;
  protected readonly increaseIconDisabled = this.settings.increaseIconDisabled;
  protected readonly decreaseIconDisabled = this.settings.decreaseIconDisabled;

  protected setLayout(l: 'grid' | 'list'): void {
    this.settings.setLayout(l);
  }
  protected setSort(k: string): void {
    this.settings.setSort(k);
  }
  protected toggleSort(column: string): void {
    this.settings.toggleSort(column);
  }
  protected toggleShowHidden(v: boolean): void {
    this.settings.toggleShowHidden(v);
  }
  protected increaseIconSize(): void {
    this.settings.increaseIconSize();
  }
  protected decreaseIconSize(): void {
    this.settings.decreaseIconSize();
  }

  // ── Actions aliases (keep template unchanged) ────────────────────────────────
  // `contextMenuItem` is a signal — expose as a getter so the template calls it.
  protected get contextMenuItem() {
    return this.actions.contextMenuItem;
  }

  protected openShortcutsModal(): void {
    this.actions.openShortcutsModal();
  }
  protected onSidebarRequestAbout(r: ExplorerRoot): void {
    this.actions.openAboutModal(r);
  }
  protected onSidebarRequestCleanup(r: ExplorerRoot): void {
    void this.actions.confirmAndCleanup(r);
  }
  protected onSidebarRequestProperties(item: FileBrowserItem): void {
    this.actions.openPropertiesDialog('bookmark', item);
  }
  protected openBookmarkInNewTab(bm: FileBrowserItem): void {
    this.actions.openBookmarkInNewTab(bm);
  }
  protected openBookmarkInNewWindow(bm: FileBrowserItem): void {
    this.actions.openBookmarkInNewWindow(bm);
  }
  protected openContextMenuOpen(): void {
    const item = this.actions.contextMenuItem();
    if (item) this.navigateTo(item);
  }
  protected openContextMenuOpenInNewTab(): void {
    this.actions.openContextMenuOpenInNewTab();
  }
  protected openContextMenuOpenInNewWindow(): void {
    this.actions.openContextMenuOpenInNewWindow();
  }
  protected getFormattedPath(item: FileBrowserItem | null): string {
    if (!item) return this.fullPathInput();
    const remote = this.tabSvc.activeRemote();
    if (!remote) return '';

    const cleanRemote = remote.isLocal
      ? remote.name
      : this.pathSelectionService.normalizeRemoteForRclone(remote.name) + ':';

    return `${cleanRemote}${item.entry.Path}`.replace('//', '/');
  }
  protected openPropertiesDialog(source: 'contextMenu' | 'bookmark', item?: FileBrowserItem): void {
    this.actions.openPropertiesDialog(source, item);
  }
  protected openContextMenuNewFolder(): void {
    void this.actions.openNewFolder();
  }
  protected openContextMenuRename(): void {
    void this.actions.openRename();
  }
  protected deleteSelectedItems(): void {
    void this.actions.deleteSelectedItems();
  }
  protected removeEmptyDirs(): void {
    void this.actions.removeEmptyDirs();
  }

  // ── Drag/drop aliases ────────────────────────────────────────────────────────
  protected get isDragging() {
    return this.dragDrop.isDragging;
  }
  protected get hoveredFolder() {
    return this.dragDrop.hoveredFolder;
  }
  protected get hoveredFolderPaneIndex() {
    return this.dragDrop.hoveredFolderPaneIndex;
  }
  protected get hoveredSegmentIndex() {
    return this.dragDrop.hoveredSegmentIndex;
  }
  protected get hoveredTabIndex() {
    return this.dragDrop.hoveredTabIndex;
  }
  protected get hoveredSidebarItem() {
    return this.dragDrop.hoveredSidebarItem;
  }

  // ── Picker state ──────────────────────────────────────────────────────────────
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

  // ── Tab / pane state (proxied from tabSvc) ───────────────────────────────────
  protected readonly starredMode = this.tabSvc.starredMode;
  protected readonly starredModeRight = this.tabSvc.starredModeRight;
  protected readonly activeStarredMode = this.tabSvc.activeStarredMode;
  protected readonly nautilusRemote = this.tabSvc.nautilusRemote;
  protected readonly currentPath = this.tabSvc.currentPath;
  protected readonly rawFiles = this.tabSvc.rawFiles;
  protected readonly errorState = this.tabSvc.errorState;
  protected readonly isLoading = this.tabSvc.isLoading;
  protected readonly nautilusRemoteRight = this.tabSvc.nautilusRemoteRight;
  protected readonly currentPathRight = this.tabSvc.currentPathRight;
  protected readonly isLoadingRight = this.tabSvc.isLoadingRight;
  protected readonly errorStateRight = this.tabSvc.errorStateRight;
  protected readonly rawFilesRight = this.tabSvc.rawFilesRight;
  protected readonly selectedItems = this.tabSvc.selectedItems;
  protected readonly selectedItemsRight = this.tabSvc.selectedItemsRight;
  protected readonly tabs = this.tabSvc.tabs;
  protected readonly activeTabIndex = this.tabSvc.activeTabIndex;
  protected readonly mappedTabs = this.tabSvc.mappedTabs;
  protected readonly activePaneIndex = this.tabSvc.activePaneIndex;
  protected readonly activeRemote = this.tabSvc.activeRemote;
  protected readonly activePath = this.tabSvc.activePath;
  protected readonly activeFiles = this.tabSvc.activeFiles;
  protected readonly canGoBack = this.tabSvc.canGoBack;
  protected readonly canGoForward = this.tabSvc.canGoForward;
  protected readonly splitDividerPos = this.tabSvc.splitDividerPos;
  protected readonly isSplitEnabled = this.tabSvc.isSplitEnabled;
  protected readonly splitGridColumns = this.tabSvc.splitGridColumns;

  // ── FileOps state ────────────────────────────────────────────────────────────
  protected readonly hasClipboard = this.fileOps.hasClipboard;
  protected readonly cutItemPaths = this.fileOps.cutItemPaths;
  protected readonly canUndo = this.fileOps.canUndo;
  protected readonly canRedo = this.fileOps.canRedo;

  // ── UI state ──────────────────────────────────────────────────────────────────
  protected readonly isEditingPath = signal(false);
  protected readonly isSearchMode = signal(false);
  protected readonly searchFilter = signal('');
  protected readonly currentMenuView = signal<'main' | 'open'>('main');
  protected readonly contextMenuHeight = signal<number | null>(null);
  private readonly initialLocationApplied = signal(false);
  private lastSelectedIndex: number | null = null;

  private readonly _langChange = toSignal(this.translate.onLangChange.pipe(startWith(null)));

  // ── Computed path/breadcrumb ─────────────────────────────────────────────────
  protected readonly pathSegments = computed(() => {
    const path = this.activePath();
    if (!path) return [];
    const parts = path.split('/').filter(Boolean);
    return parts.map((name, i) => ({
      name,
      path: parts.slice(0, i + 1).join('/'),
    }));
  });

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

  protected readonly bottomBarOffset = computed(() =>
    this.isMobile() || this.isPickerMode() ? '64px' : '4px'
  );

  // ── Sidebar data (picker-filtered) ──────────────────────────────────────────
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

  // ── Sort options metadata ────────────────────────────────────────────────────
  protected readonly sortOptions = [
    { key: 'name-asc', label: 'nautilus.sort.az' },
    { key: 'name-desc', label: 'nautilus.sort.za' },
    { key: 'modified-desc', label: 'nautilus.sort.lastModified' },
    { key: 'modified-asc', label: 'nautilus.sort.firstModified' },
    { key: 'size-desc', label: 'nautilus.sort.sizeLargest' },
    { key: 'size-asc', label: 'nautilus.sort.sizeSmallest' },
  ];

  // ── File list (filtered + sorted) ───────────────────────────────────────────
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
    const sort = this.settings.sortKey().split('-')[0] as 'name' | 'size' | 'modified';
    const ascending = !this.settings.sortKey().endsWith('desc');
    const multiplier = ascending ? 1 : -1;

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

  protected readonly selectionSummary = computed(() => {
    this._langChange(); // re-run on language change

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
      if (item.entry.IsDir) {
        return `${name} ${sel}`;
      }
      return `${name} ${sel} (${this.formatFileSizePipe.transform(item.entry.Size)})`;
    }

    const parts: string[] = [];
    const folderItems = selected.filter(i => i.entry.IsDir);
    const fileItems = selected.filter(i => !i.entry.IsDir);
    const sel = this.translate.instant('nautilus.selection.selected');

    if (folderItems.length) {
      const label = this.translate.instant(
        folderItems.length > 1 ? 'nautilus.selection.folders' : 'nautilus.selection.folder'
      );
      parts.push(`${folderItems.length} ${label} ${sel}`);
    }
    if (fileItems.length) {
      const totalSize = fileItems.reduce((sum, i) => sum + i.entry.Size, 0);
      const formattedSize = this.formatFileSizePipe.transform(totalSize);
      const label = this.translate.instant(
        fileItems.length > 1 ? 'nautilus.selection.items' : 'nautilus.selection.item'
      );
      parts.push(`${fileItems.length} ${label} ${sel} (${formattedSize})`);
    }

    return parts.join(', ');
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  constructor() {
    this._setupEffects();

    this.keyboard.register({
      navigateTo: item => this.navigateTo(item),
      getSelectedItems: () => this._getSelectedItemsList(),
      setContextItem: item => this.setContextItem(item),
      openInNewTab: () => this.actions.openContextMenuOpenInNewTab(),
      openInNewWindow: () => this.actions.openContextMenuOpenInNewWindow(),
      openRename: () => this.actions.openRename(),
      openNewFolder: () => this.actions.openNewFolder(),
      openProperties: () => this.actions.openPropertiesDialog('contextMenu'),
      deleteSelected: () => this.actions.deleteSelectedItems(),
      selectAll: () => this.selectAll(),
      clearSelection: () => this.clearSelection(),
      clearClipboard: () => this.fileOps.clearClipboard(),
      pasteItems: () => this.pasteItems(),
      refresh: () => this.refresh(),
      toggleSplit: () => this.tabSvc.toggleSplit(),
      toggleSearch: () => this.toggleSearchMode(),
      toggleShowHidden: v => this.settings.toggleShowHidden(v),
      isEditingPath: this.isEditingPath,
      pathSegments: this.pathSegments,
      showHidden: this.settings.showHidden,
      isPickerMode: this.isPickerMode,
      navigateToSegment: index => this.navigateToSegment(index),
    });

    this.dragDrop.register({
      getContext: () => ({
        activeRemote: this.activeRemote(),
        activePath: this.activePath(),
        panes: [
          { remote: this.tabSvc.getPaneRef(0).remote(), path: this.tabSvc.getPaneRef(0).path() },
          { remote: this.tabSvc.getPaneRef(1).remote(), path: this.tabSvc.getPaneRef(1).path() },
        ],
        files: this.files(),
        filesRight: this.filesRight(),
        activePaneIndex: this.activePaneIndex(),
        pathSegments: this.pathSegments(),
        tabs: this.tabs().map(t => ({
          id: t.id,
          left: { remote: t.left.remote, path: t.left.path },
        })),
        allRemotesLookup: this.allRemotesLookup(),
        bookmarks: this.bookmarks(),
      }),
      navigateTo: item => this.navigateTo(item),
      navigateToSegment: index => this.navigateToSegment(index),
      updatePath: path => this.updatePath(path),
      switchTab: index => this.switchTab(index),
      switchPane: index => this.switchPane(index),
      selectStarred: () => this.selectStarred(),
      selectRemote: remote => this.selectRemote(remote),
      openBookmark: bm => this.openBookmark(bm),
      toggleStar: item => this.toggleStar(item),
      isStarred: item => this.isStarred(item),
      toggleBookmark: item => this.toggleBookmark(item),
      refresh: () => this.refresh(),
    });

    this.tabSvc.onCloseOverlay = () => this.closeOverlay.emit();

    this.destroyRef.onDestroy(() => {
      this.nautilusService.setWindowTitle('RClone Manager');
    });
  }

  async ngOnInit(): Promise<void> {
    const applied = await this.tabSvc.setupInitialTab(this.localDrives(), this.cloudRemotes());
    this.initialLocationApplied.set(applied);
    void this.dragDrop.setupDesktopNativeDropListener();
  }

  // ── Effects ───────────────────────────────────────────────────────────────────

  private _setupEffects(): void {
    // Close sidenav on mobile.
    effect(() => {
      this.isSidenavOpen.set(!this.isMobile());
    });

    // Track context menu height for sliding animation
    effect(() => {
      this.currentMenuView();
      // Wait for DOM to update and measure the correct menu page
      setTimeout(() => {
        const activePage = document.querySelector('.menu-page.active-page');
        if (activePage) {
          this.contextMenuHeight.set((activePage as HTMLElement).offsetHeight);
        }
      }, 0);
    });

    // Fallback: apply initialLocation if remote data wasn't ready during setupInitialTab.
    effect(() => {
      const open = this.isPickerMode();
      const applied = this.initialLocationApplied();
      const cfg = this.pickerOptions();

      if (open && !applied && cfg.initialLocation) {
        if (!this.tabSvc.isDataReadyForConfig(cfg, this.localDrives(), this.cloudRemotes())) return;
        if (this.tabSvc.isLocationAllowedByConfig(cfg.initialLocation, cfg)) {
          this.navigateToPath(cfg.initialLocation);
          this.initialLocationApplied.set(true);
        }
      }

      if (!open && applied) this.initialLocationApplied.set(false);
    });

    // Handle dynamic remote selection (e.g. from Tray).
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
          const parsed = this.tabSvc.parseLocationToRemoteAndPath(targetPath);
          if (parsed && this.tabs().length > 0) {
            this._navigate(parsed.remote, parsed.path, true);
            this.nautilusService.targetPath.set(null);
          }
        });
      }
    });

    // URL sync.
    effect(() => {
      if (this.isPickerMode()) return;
      const remote = this.activeRemote();
      const path = this.activePath();
      const isOpen = this.nautilusService.isNautilusOverlayOpen();
      const isStandalone = this.nautilusService.isStandaloneWindow();

      untracked(() => {
        let newPath = '/';
        if (isOpen || isStandalone) {
          if (remote) {
            newPath = `/nautilus/${encodeURIComponent(remote.name)}${path ? `/${path}` : ''}`;
          } else {
            newPath = '/nautilus';
          }
        }
        if (window.location.pathname !== newPath) {
          window.history.replaceState(null, '', newPath + window.location.search);
        }
      });
    });

    // Window title.
    effect(() => {
      const isPicker = this.isPickerMode();
      const remote = this.activeRemote();
      const path = this.activePath();
      const starred = this.activeStarredMode();
      this._langChange();

      const appSuffix = 'RClone Browser';
      let segment: string;

      if (isPicker) {
        segment = this.translate.instant(this.title());
      } else if (starred) {
        segment = this.translate.instant('nautilus.titles.starred');
      } else if (remote) {
        segment = path
          ? (path.split('/').filter(Boolean).pop() ?? path)
          : this.translate.instant(remote.label || remote.name);
      } else {
        segment = this.translate.instant('nautilus.titles.files');
      }

      this.nautilusService.setWindowTitle(segment ? `${segment} - ${appSuffix}` : appSuffix);
    });
  }

  // ── Navigation ────────────────────────────────────────────────────────────────

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

    const parsed = this.tabSvc.parseLocationToRemoteAndPath(rawInput);
    if (parsed) {
      this._navigate(parsed.remote, parsed.path, true);
      return;
    }

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
        this.tabSvc.createTab(pane.remote, item.entry.Path);
      }
    } else {
      const files = this.activePaneIndex() === 0 ? this.files() : this.filesRight();
      void this.actions.openFilePreview(item, files);
    }
  }

  protected _navigate(remote: ExplorerRoot | null, path: string, newHistory = true): void {
    this.tabSvc._navigate(remote, path, newHistory);
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

  selectStarred(): void {
    if (this.activeStarredMode()) return;
    this._navigate(null, '', true);
  }

  // ── Tab management (thin wrappers) ────────────────────────────────────────────

  protected switchTab(i: number): void {
    this.tabSvc.switchTab(i);
  }
  protected closeTab(i: number): void {
    this.tabSvc.closeTab(i);
  }
  protected closeOtherTabs(index: number): void {
    this.tabSvc.closeOtherTabs(index);
  }
  protected closeTabsToRight(index: number): void {
    this.tabSvc.closeTabsToRight(index);
  }
  protected duplicateTab(index: number): void {
    this.tabSvc.duplicateTab(index);
  }
  protected moveTab(previousIndex: number, currentIndex: number): void {
    this.tabSvc.moveTab(previousIndex, currentIndex);
  }
  protected toggleSplit(): void {
    this.tabSvc.toggleSplit();
  }
  protected switchPane(index: 0 | 1): void {
    this.tabSvc.switchPane(index);
  }
  protected goBack(): void {
    this.tabSvc.goBack();
  }
  protected goForward(): void {
    this.tabSvc.goForward();
  }
  protected openRemoteInNewTab(remote: ExplorerRoot): void {
    this.tabSvc.createTab(remote, '');
  }
  protected openRemoteInNewWindow(remote: ExplorerRoot): void {
    this.nautilusService.newNautilusWindow(remote.name, '');
  }
  protected refresh(): void {
    this.tabSvc.refresh(this.activePaneIndex());
  }

  // ── Split divider ─────────────────────────────────────────────────────────────

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
      this.settings.saveSplitDividerPos(this.splitDividerPos());
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  // ── Selection ─────────────────────────────────────────────────────────────────

  onItemClick(item: FileBrowserItem, event: Event, index: number, paneIndex: 0 | 1): void {
    event.stopPropagation();
    if (this.isPickerMode() && !this.isItemSelectable(item.entry)) return;

    if (this.activePaneIndex() !== paneIndex) this.switchPane(paneIndex);

    const currentSel = paneIndex === 0 ? this.selectedItems() : this.selectedItemsRight();
    const multi = !this.isPickerMode() || !!this.pickerOptions().multi;
    const e = event as MouseEvent;
    const itemKey = this.getItemKey(item);
    const newSel = new Set<string>();

    if (e.shiftKey && this.lastSelectedIndex !== null && multi) {
      const files = paneIndex === 0 ? this.files() : this.filesRight();
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

    this.tabSvc.syncSelection(newSel, paneIndex);
  }

  setContextItem(item: FileBrowserItem | null, paneIndex?: 0 | 1): void {
    this.actions.contextMenuItem.set(item);
    this.currentMenuView.set('main');
    this.contextMenuHeight.set(null);

    if (item) {
      const pIdx = paneIndex ?? this.activePaneIndex();
      if (this.activePaneIndex() !== pIdx) this.switchPane(pIdx);

      const currentSelection = pIdx === 0 ? this.selectedItems() : this.selectedItemsRight();
      if (!currentSelection.has(this.getItemKey(item))) {
        this.tabSvc.syncSelection(new Set<string>([this.getItemKey(item)]), pIdx);
        this.lastSelectedIndex = (pIdx === 0 ? this.files() : this.filesRight()).findIndex(
          f => this.getItemKey(f) === this.getItemKey(item)
        );
      }
    }
  }

  protected onUpdateSelection(selection: Set<string>, paneIndex: 0 | 1): void {
    this.tabSvc.getPaneRef(paneIndex).selection.set(selection);
  }

  clearSelection(): void {
    this.tabSvc.syncSelection(new Set());
  }

  selectAll(): void {
    this.tabSvc.syncSelection(new Set(this.files().map(f => this.getItemKey(f))));
  }

  // ── Clipboard & file ops (thin wrappers) ──────────────────────────────────────

  protected copyItems(): void {
    this.fileOps.copyItems(this._getSelectedItemsList());
  }
  protected cutItems(): void {
    this.fileOps.cutItems(this._getSelectedItemsList());
  }
  protected clearClipboard(): void {
    this.fileOps.clearClipboard();
  }

  protected async pasteItems(): Promise<void> {
    await this.fileOps.pasteItems(this.activeRemote(), this.activePath(), this.allRemotesLookup());
    this.refresh();
  }

  async undoLastOperation(): Promise<void> {
    await this.fileOps.undoLastOperation();
    this.refresh();
  }

  async redoLastOperation(): Promise<void> {
    await this.fileOps.redoLastOperation();
    this.refresh();
  }

  // ── Stars & bookmarks ────────────────────────────────────────────────────────

  toggleStar(item: FileBrowserItem): void {
    this.nautilusService.toggleItem('starred', item);
  }

  isStarred(item: FileBrowserItem): boolean {
    const remote = item.meta.remote || this.nautilusRemote()?.name;
    if (!remote) return false;
    return this.nautilusService.isSaved('starred', remote, item.entry.Path);
  }

  toggleBookmark(item: FileBrowserItem): void {
    this.nautilusService.toggleItem('bookmarks', item);
  }

  // ── Misc ──────────────────────────────────────────────────────────────────────

  cancelLoad(paneIndex: 0 | 1 = 0): void {
    const pane = this.tabSvc.getPaneRef(paneIndex);
    pane.loading.set(false);
    void this.tabSvc.stopListReadGroup(this.tabSvc.listReadGroups[paneIndex]);
  }

  toggleSearchMode(): void {
    this.isSearchMode.update(v => !v);
    this.searchFilter.set('');
  }

  onSidebarSidenavAction(action: 'close' | 'toggle'): void {
    if (action === 'close') this.sidenav.close();
    else this.sidenav.toggle();
  }

  // ── Drag/drop passthrough ─────────────────────────────────────────────────────

  onDragStarted(event: DragEvent, item: FileBrowserItem): void {
    const currentSelected = this.selectedItems();
    const items = currentSelected.has(this.getItemKey(item))
      ? (this.activePaneIndex() === 0 ? this.files() : this.filesRight()).filter(f =>
          currentSelected.has(this.getItemKey(f))
        )
      : [item];
    this.dragDrop.startDrag(event, items, this.activePaneIndex());
  }

  onDragEnded(): void {
    this.dragDrop.endDrag();
  }
  onDragOver(event: DragEvent): void {
    this.dragDrop.onDragOver(event);
  }
  onContainerDragEnter(event: DragEvent): void {
    this.dragDrop.onContainerDragEnter(event);
  }
  onContainerDragLeave(event: DragEvent): void {
    this.dragDrop.onContainerDragLeave(event);
  }
  onContainerDrop(event: DragEvent): void {
    this.dragDrop.onContainerDrop(event);
  }
  onDropToStarred(event: DragEvent): void {
    this.dragDrop.dropToStarred(event);
  }
  onDropToLocal(event: DragEvent): void {
    this.dragDrop.dropToLocal(event);
  }
  async onDropToBookmark(e: DragEvent, bm: FileBrowserItem): Promise<void> {
    await this.dragDrop.dropToBookmark(e, bm);
  }
  async onDropToRemote(e: DragEvent, remote: ExplorerRoot): Promise<void> {
    await this.dragDrop.dropToRemote(e, remote);
  }
  async onDropToCurrentDirectory(e: DragEvent, paneIndex: number): Promise<void> {
    await this.dragDrop.dropToCurrentDirectory(e, paneIndex);
  }
  async onDropToSegment(e: DragEvent, segIdx: number): Promise<void> {
    await this.dragDrop.dropToSegment(e, segIdx);
  }

  // ── Picker ────────────────────────────────────────────────────────────────────

  confirmSelection(): void {
    let items = this._getSelectedItemsList();
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

  isItemSelectable = (item: import('@app/types').Entry): boolean => {
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

  protected readonly getItemKey = (item: FileBrowserItem | null): string => {
    if (!item) return '';
    return `${item.meta.remote}:${item.entry.Path}`;
  };

  private _getSelectedItemsList(): FileBrowserItem[] {
    const selection = this.selectedItems();
    return this.activeFiles().filter((item: FileBrowserItem) =>
      selection.has(this.getItemKey(item))
    );
  }
}

import { inject, Injectable, signal, computed, DestroyRef, WritableSignal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { TranslateService } from '@ngx-translate/core';
import { EMPTY, from, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { LocalStorageService } from './state/local-storage.service';
import {
  NotificationService,
  PathService,
  RemoteFileOperationsService,
  JobManagementService,
  NautilusService,
} from '@app/services';
import { ExplorerRoot, FileBrowserItem, FilePickerConfig, ORIGINS } from '@app/types';
import { TabItem } from '../../file-browser/nautilus/tabs/nautilus-tabs.component';
import { FileViewerService } from '../ui/file-viewer.service';

export interface PaneState {
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

export interface Tab {
  id: number;
  title: string;
  left: PaneState;
  right?: PaneState;
}

/** Signals for a specific pane, resolved by index. */
export interface PaneRef {
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

@Injectable()
export class NautilusTabService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly translate = inject(TranslateService);
  private readonly notificationService = inject(NotificationService);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly pathService = inject(PathService);
  private readonly localStorage = inject(LocalStorageService);
  private readonly nautilusService = inject(NautilusService);
  private readonly fileViewerSvc = inject(FileViewerService);

  public readonly listReadGroups: Record<0 | 1, string> = {
    0: `ui/nautilus/list-left-${Date.now().toString(36)}`,
    1: `ui/nautilus/list-right-${Date.now().toString(36)}`,
  };

  /** Callback when the last tab is closed. */
  onCloseOverlay!: () => void;

  // -- Signals --
  readonly pendingPreviewFilePath = signal<string | null>(null);
  readonly nautilusRemote = signal<ExplorerRoot | null>(null);
  readonly currentPath = signal<string>('');
  readonly refreshTrigger = signal(0);
  readonly rawFiles = signal<FileBrowserItem[]>([]);
  readonly errorState = signal<string | null>(null);
  readonly isLoading = signal(false);

  readonly nautilusRemoteRight = signal<ExplorerRoot | null>(null);
  readonly currentPathRight = signal<string>('');
  readonly refreshTriggerRight = signal(0);
  readonly isLoadingRight = signal(false);
  readonly errorStateRight = signal<string | null>(null);
  readonly rawFilesRight = signal<FileBrowserItem[]>([]);

  readonly selectedItems = signal<Set<string>>(new Set());
  readonly selectedItemsRight = signal<Set<string>>(new Set());

  private interfaceTabCounter = 0;
  readonly tabs = signal<Tab[]>([]);
  readonly activeTabIndex = signal(0);
  readonly activePaneIndex = signal<0 | 1>(0);
  readonly splitDividerPos = signal(
    this.localStorage.get<number>('nautilus.split_divider_pos', 50)
  );

  // -- Computeds --
  readonly mappedTabs = computed((): TabItem[] =>
    this.tabs().map(tab => ({
      id: tab.id,
      title: tab.title,
      path: tab.left.path,
      remote: tab.left.remote ? { name: tab.left.remote.name, label: tab.left.remote.label } : null,
    }))
  );

  readonly activeRemote = computed(() =>
    this.activePaneIndex() === 0 ? this.nautilusRemote() : this.nautilusRemoteRight()
  );
  readonly activePath = computed(() =>
    this.activePaneIndex() === 0 ? this.currentPath() : this.currentPathRight()
  );
  readonly activeFiles = computed(() =>
    this.activePaneIndex() === 0 ? this.rawFiles() : this.rawFilesRight()
  );
  readonly activeIsLoading = computed(() =>
    this.activePaneIndex() === 0 ? this.isLoading() : this.isLoadingRight()
  );
  readonly activeErrorState = computed(() =>
    this.activePaneIndex() === 0 ? this.errorState() : this.errorStateRight()
  );

  readonly starredMode = computed(
    () => this.nautilusRemote() === null && this.currentPath() === ''
  );
  readonly starredModeRight = computed(
    () => this.nautilusRemoteRight() === null && this.currentPathRight() === ''
  );
  readonly activeStarredMode = computed(() =>
    this.activePaneIndex() === 0 ? this.starredMode() : this.starredModeRight()
  );

  readonly canGoBack = computed(() => {
    const tab = this.tabs()[this.activeTabIndex()];
    if (!tab) return false;
    const pane = this.activePaneIndex() === 0 ? tab.left : tab.right;
    return pane ? pane.historyIndex > 0 : false;
  });
  readonly canGoForward = computed(() => {
    const tab = this.tabs()[this.activeTabIndex()];
    if (!tab) return false;
    const pane = this.activePaneIndex() === 0 ? tab.left : tab.right;
    return pane ? pane.historyIndex < pane.history.length - 1 : false;
  });

  readonly isSplitEnabled = computed(() => !!this.tabs()[this.activeTabIndex()]?.right);
  readonly splitGridColumns = computed(() =>
    this.isSplitEnabled() ? `${this.splitDividerPos()}% 0.5rem 1fr` : '1fr'
  );

  constructor() {
    this.loadFilesForPane(0);
    this.loadFilesForPane(1);

    this.destroyRef.onDestroy(() => {
      void this.stopListReadJobs();
    });

    this.setupBackendEventListener();
  }

  // ── Selection ────────────────────────────────────────────────────────────────

  /**
   * Updates both the live pane signal and the serialised tab state so the
   * selection is preserved when switching tabs.
   */
  syncSelection(newSelection: Set<string>, paneIndex?: 0 | 1): void {
    const pIdx = paneIndex ?? this.activePaneIndex();
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

  // -- Pane accessors --

  getPaneRef(paneIndex: 0 | 1): PaneRef {
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

  // ── Initial tab setup ────────────────────────────────────────────────────────

  /**
   * Bootstraps the first tab.  Called from `NautilusComponent.ngOnInit` after
   * `loadRemoteData` completes.  Returns `true` if the picker's `initialLocation`
   * was successfully applied (so the component can set `initialLocationApplied`).
   *
   * @param filteredLocalDrives  Local drives already filtered for picker mode.
   * @param filteredCloudRemotes Cloud remotes already filtered for picker mode.
   */
  async setupInitialTab(
    filteredLocalDrives: ExplorerRoot[],
    filteredCloudRemotes: ExplorerRoot[]
  ): Promise<boolean> {
    await this.nautilusService.loadRemoteData();

    const pickerState = this.nautilusService.filePickerState();
    let initialRemote: ExplorerRoot | null = null;
    let initialPath = '';
    let initialLocationApplied = false;

    const tryParse = (loc: string): boolean => {
      const parsed = this.pathService.parseLocation(loc, this.nautilusService.allRemotesLookup());
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
        this.isDataReadyForConfig(cfg, filteredLocalDrives, filteredCloudRemotes) &&
        this.isLocationAllowedByConfig(loc, cfg) &&
        tryParse(loc)
      ) {
        initialLocationApplied = true;
      }
    }

    // Priority 2: Service-level overrides (Tray / Debug)
    if (!initialRemote) {
      const targetPath = this.nautilusService.targetPath();
      if (targetPath && tryParse(targetPath)) {
        this.nautilusService.targetPath.set(null);
      } else {
        const requestedName = this.nautilusService.selectedNautilusRemote();
        if (requestedName) {
          initialRemote =
            this.nautilusService.allRemotesLookup().find(r => r.name === requestedName) ?? null;
          this.nautilusService.selectedNautilusRemote.set(null);
        }
      }
    }

    // Priority 3: Picker-mode defaults
    if (!initialRemote && pickerState.isOpen && pickerState.options) {
      const opts = pickerState.options;
      if (opts.mode === 'remote') {
        initialRemote =
          (opts.allowedRemotes?.length
            ? filteredCloudRemotes.find(r => opts.allowedRemotes?.includes(r.name))
            : filteredCloudRemotes[0]) ?? null;
      } else {
        initialRemote = filteredLocalDrives[0] ?? null;
      }
    }

    // Priority 4: Standard fallback
    initialRemote ??= this.nautilusService.localDrives()[0] ?? null;

    if (initialRemote && initialPath) {
      try {
        const fsName = initialRemote.isLocal
          ? initialRemote.name
          : this.pathService.normalizeRemoteForRclone(initialRemote.name);
        const stat = await this.remoteOps.getStat(fsName, initialPath);
        if (stat && stat.item && !stat.item.IsDir) {
          this.pendingPreviewFilePath.set(initialPath);
          initialPath = this.pathService.getParentPath(initialPath);
        }
      } catch (err) {
        console.debug('Failed to getStat for initial path:', err);
      }
    }

    this.createTab(initialRemote, initialPath);
    return initialLocationApplied;
  }

  isLocationAllowedByConfig(loc: string, cfg: FilePickerConfig): boolean {
    const hasColon = loc.includes(':');
    if (cfg.mode === 'local' && hasColon) return false;
    if (cfg.mode === 'remote') {
      if (!hasColon) return false;
      const remote = this.pathService.getRemoteNameFromFs(loc);
      if (cfg.allowedRemotes?.length) return cfg.allowedRemotes.includes(remote);
      return true;
    }
    if (hasColon && cfg.allowedRemotes?.length) {
      return cfg.allowedRemotes.includes(this.pathService.getRemoteNameFromFs(loc));
    }
    return true;
  }

  isDataReadyForConfig(
    cfg: FilePickerConfig,
    localDrives: ExplorerRoot[],
    cloudRemotes: ExplorerRoot[]
  ): boolean {
    const hasColon = !!cfg.initialLocation && cfg.initialLocation.includes(':');

    if (cfg.initialLocation) {
      if (hasColon) {
        if (cloudRemotes.length === 0) return false;
        if (cfg.allowedRemotes?.length) {
          const r = this.pathService.getRemoteNameFromFs(cfg.initialLocation);
          return cfg.allowedRemotes.includes(r) && cloudRemotes.some(x => x.name === r);
        }
        return true;
      }
      return localDrives.length > 0;
    }

    if (cfg.mode === 'local') return localDrives.length > 0;
    if (cfg.mode === 'remote') {
      if (cloudRemotes.length === 0) return false;
      if (cfg.allowedRemotes?.length)
        return cloudRemotes.some(x => cfg.allowedRemotes!.includes(x.name));
      return true;
    }
    return true;
  }

  // -- Tab management --

  refresh(paneIndex: 0 | 1): void {
    const ref = this.getPaneRef(paneIndex);
    ref.refreshTrigger.update(v => v + 1);
  }

  /**
   * Refreshes any pane/tab that is currently viewing the specified remote and path.
   */
  refreshPath(remoteName: string, path: string): void {
    const normalizedTargetRemote = this.pathService.normalizeRemoteName(remoteName);
    const normalizedTargetPath = this.pathService.normalizePath(path).replace(/^\/+|\/+$/g, '');

    // 1. Refresh active pane signals if they match
    for (let i = 0; i < 2; i++) {
      const ref = this.getPaneRef(i as 0 | 1);
      const remote = ref.remote();
      if (!remote) continue;

      const normRemote = this.pathService.normalizeRemoteName(remote.name, remote.isLocal);
      const normPath = this.pathService.normalizePath(ref.path()).replace(/^\/+|\/+$/g, '');

      if (normRemote === normalizedTargetRemote && normPath === normalizedTargetPath) {
        this.refresh(i as 0 | 1);
      }
    }

    // 2. Update all matching PaneStates in all tabs
    this.tabs.update(tabs =>
      tabs.map(tab => {
        const updatePane = (pane: PaneState): PaneState => {
          if (!pane.remote) return pane;
          const normRemote = this.pathService.normalizeRemoteName(
            pane.remote.name,
            pane.remote.isLocal
          );
          const normPath = this.pathService.normalizePath(pane.path).replace(/^\/+|\/+$/g, '');

          if (normRemote === normalizedTargetRemote && normPath === normalizedTargetPath) {
            pane.refreshTrigger.update(v => v + 1);
          }
          return pane;
        };

        const newTab = { ...tab, left: updatePane({ ...tab.left }) };
        if (tab.right) {
          newTab.right = updatePane({ ...tab.right });
        }
        return newTab;
      })
    );
  }

  /**
   * Refresh multiple paths at once.
   */
  refreshAffectedPaths(affected: { remote: string; path: string }[]): void {
    const unique = new Set(affected.map(a => `${a.remote}||${a.path}`));
    unique.forEach(u => {
      const [remote, path] = u.split('||');
      this.refreshPath(remote, path);
    });
  }

  createPaneState(remote: ExplorerRoot | null, path = ''): PaneState {
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
    const displaySeg = this.pathService.getDisplaySegment(remote, path);
    const title = displaySeg
      ? this.translate.instant(displaySeg)
      : this.translate.instant(!remote ? 'nautilus.titles.starred' : 'nautilus.titles.files');

    const paneState = this.createPaneState(remote, path);

    // Reuse active files if opening a duplicate location.
    const activeRemote = this.activeRemote();
    const activePath = this.activePath();
    if (remote && activeRemote && remote.name === activeRemote.name && path === activePath) {
      const pIdx = this.activePaneIndex();
      paneState.rawFiles.set(pIdx === 0 ? this.rawFiles() : this.rawFilesRight());
      paneState.isLoading.set(pIdx === 0 ? this.isLoading() : this.isLoadingRight());
      paneState.error.set(pIdx === 0 ? this.errorState() : this.errorStateRight());
    }

    const isInitial = this.tabs().length === 0;
    const isSplitPersisted = this.localStorage.get<boolean>('nautilus.is_split_enabled', false);

    const t: Tab = { id, title, left: paneState };
    if (isInitial && isSplitPersisted) {
      const rightRemoteName = this.localStorage.get<string | null>(
        'nautilus.right_remote_name',
        null
      );
      const rightPath = this.localStorage.get<string>('nautilus.right_path', '');
      let rightRemote: ExplorerRoot | null = null;
      if (rightRemoteName) {
        rightRemote =
          this.nautilusService.allRemotesLookup().find(r => r.name === rightRemoteName) ?? null;
      }
      t.right = this.createPaneState(rightRemote ?? remote, rightRemote ? rightPath : path);
    }

    this.tabs.update(list => [...list, t]);
    this.switchTab(this.tabs().length - 1);
  }

  closeTab(i: number): void {
    if (i < 0 || i >= this.tabs().length) return;
    this.tabs.update(list => list.filter((_, idx) => idx !== i));
    if (this.tabs().length === 0) {
      this.onCloseOverlay?.();
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
    this.persistSplitState(t);
  }

  closeOtherTabs(index: number): void {
    const list = this.tabs();
    if (index < 0 || index >= list.length) return;
    this.tabs.set([list[index]]);
    this.switchTab(0);
  }

  closeTabsToRight(index: number): void {
    const list = this.tabs();
    if (index < 0 || index >= list.length) return;
    this.tabs.set(list.slice(0, index + 1));
    if (this.activeTabIndex() > index) this.switchTab(index);
  }

  duplicateTab(index: number): void {
    const tab = this.tabs()[index];
    if (!tab) return;
    this.createTab(tab.left.remote, tab.left.path);
  }

  moveTab(previousIndex: number, currentIndex: number): void {
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

  toggleSplit(): void {
    const idx = this.activeTabIndex();
    const tab = this.tabs()[idx];
    if (!tab) return;

    this.tabs.update(list =>
      list.map((t, i) => {
        if (i !== idx) return t;
        if (t.right) {
          const rest = { ...t };
          delete rest.right;
          return rest;
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
    this.persistSplitState(updatedTab);
  }

  syncPaneSignals(paneIndex: 0 | 1, state: PaneState): void {
    const ref = this.getPaneRef(paneIndex);
    ref.remote.set(state.remote);
    ref.path.set(state.path);
    ref.selection.set(state.selection);
    ref.rawFiles.set(state.rawFiles());
    ref.loading.set(state.isLoading());
    ref.error.set(state.error());
    ref.refreshTrigger.set(state.refreshTrigger());
  }

  switchPane(index: 0 | 1): void {
    if (!this.isSplitEnabled() && index === 1) return;
    this.activePaneIndex.set(index);
  }

  traverseHistory(direction: 1 | -1): void {
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
        return {
          ...t,
          right: t.right ? { ...t.right, historyIndex: newHistoryIndex } : undefined,
        };
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

  async _navigate(remote: ExplorerRoot | null, path: string, newHistory: boolean): Promise<void> {
    if (this.pendingPreviewFilePath() !== path) {
      this.pendingPreviewFilePath.set(null);
    }

    if (remote && path) {
      try {
        const fsName = remote.isLocal
          ? remote.name
          : this.pathService.normalizeRemoteForRclone(remote.name);
        const stat = await this.remoteOps.getStat(fsName, path);
        if (stat && stat.item && !stat.item.IsDir) {
          const parentPath = this.pathService.getParentPath(path);
          this.pendingPreviewFilePath.set(path);
          this.executeNavigate(remote, parentPath, newHistory);
          return;
        }
      } catch (err) {
        console.debug('Failed to getStat for path, assuming directory:', err);
      }
    }

    this.executeNavigate(remote, path, newHistory);
  }

  executeNavigate(remote: ExplorerRoot | null, path: string, newHistory: boolean): void {
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
    const displaySeg = this.pathService.getDisplaySegment(remote, path);
    const computedTitle =
      targetStarredMode || (currentStarredMode && !remote)
        ? this.translate.instant('nautilus.titles.starred')
        : displaySeg
          ? this.translate.instant(displaySeg)
          : this.translate.instant('nautilus.titles.files');

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

    if (pIdx === 1) {
      this.persistSplitState(this.tabs()[index]);
    }
  }

  async stopListReadJobs(): Promise<void> {
    await Promise.all([
      this.stopListReadGroup(this.listReadGroups[0]),
      this.stopListReadGroup(this.listReadGroups[1]),
    ]);
  }

  async stopListReadGroup(group: string): Promise<void> {
    try {
      await this.jobManagementService.stopJobsByGroup(group);
    } catch (err) {
      console.debug('Failed to stop list read group:', err);
    }
  }

  // -- Private --

  private setupBackendEventListener(): void {
    this.nautilusService.eventListenersService
      .listenToJobCacheChanged()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(event => {
        const { status, remote, source, destination } = event;
        if ((status === 'Completed' || status === 'Failed' || status === 'Stopped') && remote) {
          const affected: { remote: string; path: string }[] = [];
          const addAffected = (pathStr: string): void => {
            const parsed = this.pathService.splitFsPath(pathStr);
            const r = parsed.remote || remote;
            affected.push({ remote: r, path: parsed.path });
            affected.push({ remote: r, path: this.pathService.getParentPath(parsed.path) });
          };

          if (source) addAffected(source);
          if (destination) addAffected(destination);

          if (affected.length > 0) {
            this.refreshAffectedPaths(affected);
          }
        }
      });
  }

  private persistSplitState(tab: Tab): void {
    const isSplit = !!tab.right;
    this.localStorage.set('nautilus.is_split_enabled', isSplit);
    if (tab.right) {
      const rightRemote = tab.right.remote;
      if (rightRemote) {
        this.localStorage.set('nautilus.right_remote_name', rightRemote.name);
      } else {
        this.localStorage.remove('nautilus.right_remote_name');
      }
      this.localStorage.set('nautilus.right_path', tab.right.path);
    }
  }

  private loadFilesForPane(paneIndex: 0 | 1): void {
    const ref = this.getPaneRef(paneIndex);

    const loadParams = computed(() => ({
      remote: ref.remote(),
      path: ref.path(),
      _trigger: ref.refreshTrigger(),
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
            : this.pathService.normalizeRemoteForRclone(remote.name);
          const readGroup = this.listReadGroups[paneIndex];

          return from(this.stopListReadGroup(readGroup)).pipe(
            switchMap(() =>
              from(this.remoteOps.getRemotePaths(fsName, path, {}, ORIGINS.FILEMANAGER, readGroup))
            ),
            map(res =>
              (res.list || []).map(
                f =>
                  ({
                    entry: f,
                    meta: {
                      remote: this.pathService.normalizeRemoteName(fsName),
                      isLocal: remote.isLocal,
                      remoteType: remote.type,
                    },
                  }) as FileBrowserItem
              )
            ),
            catchError(err => {
              const errorMessage = (err?.message ?? err ?? '').toString();
              const isCancelled = /operation cancelled|operation canceled|cancelled|canceled/i.test(
                errorMessage
              );

              if (isCancelled) {
                ref.loading.set(false);
                return EMPTY;
              }

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

        const activeTabId = this.tabs()[this.activeTabIndex()]?.id;
        const tab = this.tabs().find(t => t.id === activeTabId);
        if (!tab) return;
        const pane = paneIndex === 0 ? tab.left : tab.right;
        if (pane) {
          pane.rawFiles.set(files);
          pane.isLoading.set(false);
        }

        const pending = this.pendingPreviewFilePath();
        if (pending) {
          const item = files.find(f => f.entry.Path === pending);
          if (item) {
            this.pendingPreviewFilePath.set(null);
            const currentRemote = ref.remote();
            const actualRemoteName = item.meta.remote ?? currentRemote?.name;
            if (actualRemoteName) {
              const isLocal = item.meta.isLocal;
              const idx = files.findIndex(f => f.entry.Path === item.entry.Path);
              if (idx !== -1) {
                this.fileViewerSvc.open(
                  files.map(f => f.entry),
                  idx,
                  actualRemoteName,
                  isLocal
                );
              }
            }
          }
        }
      });
  }
}

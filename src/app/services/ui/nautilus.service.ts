import {
  ComponentRef,
  DestroyRef,
  inject,
  Injectable,
  signal,
  computed,
  WritableSignal,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { Subject } from 'rxjs';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { take } from 'rxjs/operators';
import { NautilusComponent } from 'src/app/file-browser/nautilus/nautilus.component';
import {
  AppSettingsService,
  EventListenersService,
  PathSelectionService,
  RemoteManagementService,
} from '@app/services';
import { takeUntilDestroyed, outputToObservable } from '@angular/core/rxjs-interop';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import {
  FileBrowserItem,
  CollectionType,
  FilePickerConfig,
  FilePickerResult,
  ExplorerRoot,
} from '@app/types';

@Injectable({
  providedIn: 'root',
})
export class NautilusService extends TauriBaseService {
  private readonly overlay = inject(Overlay);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly remoteManagement = inject(RemoteManagementService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly eventListenersService = inject(EventListenersService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly titleService = inject(Title);

  // --- Nautilus overlay ---
  private readonly _isNautilusOverlayOpen = signal(false);
  readonly isNautilusOverlayOpen = this._isNautilusOverlayOpen.asReadonly();

  // --- File Picker ---
  private readonly _filePickerState = signal<{ isOpen: boolean; options?: FilePickerConfig }>({
    isOpen: false,
  });
  readonly filePickerState = this._filePickerState.asReadonly();

  private readonly _filePickerResult = new Subject<FilePickerResult>();
  readonly filePickerResult$ = this._filePickerResult.asObservable();

  // --- Public signals (read by UI) ---
  readonly starredItems = signal<FileBrowserItem[]>([]);
  readonly bookmarks = signal<FileBrowserItem[]>([]);
  readonly selectedNautilusRemote = signal<string | null>(null);
  readonly targetPath = signal<string | null>(null);
  readonly isStandaloneWindow = signal(false);

  // --- Remote / Drive state ---
  readonly localDrives = signal<ExplorerRoot[]>([]);
  readonly cloudRemotes = signal<ExplorerRoot[]>([]);
  readonly allRemotesLookup = computed(() => [...this.localDrives(), ...this.cloudRemotes()]);

  // --- Overlay refs ---
  private browserOverlayRef: OverlayRef | null = null;
  private browserComponentRef: ComponentRef<NautilusComponent> | null = null;
  private pickerOverlayRef: OverlayRef | null = null;
  private pickerComponentRef: ComponentRef<NautilusComponent> | null = null;

  private readonly collectionConfig: Record<
    CollectionType,
    {
      category: string;
      key: string;
      signal: WritableSignal<FileBrowserItem[]>;
      allowFiles: boolean;
    }
  > = {
    starred: { category: 'nautilus', key: 'starred', signal: this.starredItems, allowFiles: true },
    bookmarks: {
      category: 'nautilus',
      key: 'bookmarks',
      signal: this.bookmarks,
      allowFiles: false,
    },
  };

  constructor() {
    super();
    (Object.keys(this.collectionConfig) as CollectionType[]).forEach(type =>
      this.loadCollection(type)
    );
    this.setupBrowseListener();
  }

  // ========== REMOTE DATA ==========

  async loadRemoteData(): Promise<void> {
    try {
      const [remoteNames, drives, configs] = await Promise.all([
        this.remoteManagement.getRemotes(),
        this.remoteManagement.getLocalDrives(),
        this.remoteManagement.getAllRemoteConfigs().catch(e => {
          console.error('[NautilusService] Failed to load remote configs:', e);
          return {} as Record<string, { type?: string; Type?: string }>;
        }),
      ]);

      this.localDrives.set(
        drives.map(drive => ({
          name: drive.name,
          label: drive.label || drive.name,
          type: 'hard-drive',
          isLocal: true,
          showName: drive.show_name,
          totalSpace: drive.total_space,
          availableSpace: drive.available_space,
          fileSystem: drive.file_system,
          isRemovable: drive.is_removable,
        }))
      );

      this.cloudRemotes.set(
        remoteNames.map(name => {
          const config = (configs as Record<string, { type?: string; Type?: string } | undefined>)[
            name
          ];
          return {
            name,
            label: name,
            type: config?.type ?? config?.Type ?? 'cloud',
            isLocal: false,
          };
        })
      );
    } catch (e) {
      console.error('[NautilusService] Failed to load remote data:', e);
    }
  }

  // ========== STANDALONE WINDOW / DEEP LINK ==========

  openFromBrowseQueryParam(): void {
    const urlParams = new URLSearchParams(window.location.search);
    const pathName = window.location.pathname;
    const hash = window.location.hash;

    const tauriWin = this.getCurrentTauriWindow();
    const isStandalone =
      urlParams.get('standalone') === 'nautilus' ||
      (tauriWin?.label?.startsWith('nautilus') ?? false);

    this.isStandaloneWindow.set(isStandalone);

    const { remoteName, remotePath } = this.parseNautilusLocation(urlParams, pathName, hash);

    if (remoteName) {
      if (remotePath) {
        const isLocal =
          remoteName.startsWith('/') || (remoteName.length >= 2 && remoteName[1] === ':');
        const separator = isLocal
          ? remoteName.endsWith('/') || remoteName.endsWith('\\')
            ? ''
            : '/'
          : ':';
        this.targetPath.set(`${remoteName}${separator}${remotePath}`);
      } else {
        this.selectedNautilusRemote.set(remoteName);
      }

      if (!isStandalone) {
        this._isNautilusOverlayOpen.set(true);
        this.createBrowserOverlay(false);
      }
      return;
    }

    const isNautilusRoute =
      pathName.includes('/nautilus') || hash.startsWith('#/nautilus') || urlParams.has('browse');

    if (isNautilusRoute && !isStandalone && !this._isNautilusOverlayOpen()) {
      this._isNautilusOverlayOpen.set(true);
      this.createBrowserOverlay(false);
    }
  }

  // ========== WINDOW CONTROL ==========

  setWindowTitle(title: string): void {
    // Defer so callers don't need to worry about timing relative to Tauri state.
    setTimeout(async () => {
      if (this.isTauriEnvironment) {
        await this.getCurrentTauriWindow()?.setTitle(title);
      }
      this.titleService.setTitle(title);
    }, 0);
  }

  // ========== TAB DETACHMENT & URL HELPERS ==========

  getNautilusUrl(remote: string | null, path: string | null): string {
    let url = `${window.location.origin}/nautilus`;
    if (remote) {
      url += `/${encodeURIComponent(remote)}`;
      if (path) {
        const cleanPath = path.startsWith('/') ? path.slice(1) : path;
        url += `/${encodeURIComponent(cleanPath)}`;
      }
    }
    return url;
  }

  async newNautilusWindow(remote: string | null, path: string | null): Promise<void> {
    if (this.isTauriEnvironment) {
      await this.invokeCommand('new_nautilus_window', {
        remote: remote ?? null,
        path: path ?? null,
      });
    } else {
      window.open(this.getNautilusUrl(remote, path), '_blank');
    }
  }

  // ========== BROWSER & PICKER CONTROL ==========

  toggleNautilusOverlay(): void {
    if (this._isNautilusOverlayOpen()) {
      this.closeBrowser();
    } else {
      this._isNautilusOverlayOpen.set(true);
      this.createBrowserOverlay();
    }
  }

  openForRemote(remoteName: string, showAnimation = true): void {
    this.selectedNautilusRemote.set(remoteName);
    if (this.browserOverlayRef) return;
    this._isNautilusOverlayOpen.set(true);
    this.createBrowserOverlay(showAnimation);
  }

  openPath(path: string, showAnimation = true): void {
    this.targetPath.set(path);
    if (this.browserOverlayRef) return;
    this._isNautilusOverlayOpen.set(true);
    this.createBrowserOverlay(showAnimation);
  }

  openFilePicker(options: FilePickerConfig): void {
    if (this.pickerOverlayRef) return;
    this._filePickerState.set({
      isOpen: true,
      options: { ...options, requestId: options.requestId ?? crypto.randomUUID() },
    });
    this.createPickerOverlay();
  }

  closeFilePicker(result: FileBrowserItem[] | null): void {
    const requestId = this._filePickerState().options?.requestId;
    const items = result ?? [];

    this._filePickerResult.next({
      cancelled: result === null,
      items,
      paths: items.map(i => {
        const prefix = i.meta.isLocal
          ? i.meta.remote
          : this.pathSelectionService.normalizeRemoteForRclone(i.meta.remote ?? '');
        const sep = prefix?.endsWith('/') ? '' : '/';
        return i.meta.isLocal ? `${prefix}${sep}${i.entry.Path}` : `${prefix}${i.entry.Path}`;
      }),
      requestId,
    });

    this._filePickerState.set({ isOpen: false });
    this.animateAndDisposeOverlay(this.pickerComponentRef, this.pickerOverlayRef);
    this.pickerComponentRef = null;
    this.pickerOverlayRef = null;
  }

  closeBrowser(): void {
    if (this.isStandaloneWindow()) {
      this.getCurrentTauriWindow()?.close();
      return;
    }
    this._isNautilusOverlayOpen.set(false);
    this.animateAndDisposeOverlay(this.browserComponentRef, this.browserOverlayRef);
    this.browserComponentRef = null;
    this.browserOverlayRef = null;
  }

  // ========== COLLECTIONS ==========

  isSaved(type: CollectionType, remote: string, path: string, isLocal = false): boolean {
    const cleanRemote = this.pathSelectionService.normalizeRemoteName(remote, isLocal);
    return this.collectionConfig[type]
      .signal()
      .some(
        i =>
          this.pathSelectionService.normalizeRemoteName(i.meta?.remote, i.meta?.isLocal) ===
            cleanRemote && i.entry.Path === path
      );
  }

  toggleItem(type: CollectionType, item: FileBrowserItem): void {
    const config = this.collectionConfig[type];

    if (!config.allowFiles && !item.entry.IsDir) {
      console.warn(`Cannot add a file to the ${type} collection`);
      return;
    }

    const normalizedRemote = this.pathSelectionService.normalizeRemoteName(
      item.meta?.remote ?? '',
      item.meta?.isLocal
    );
    const list = config.signal();
    const isPresent = this.isSaved(type, normalizedRemote, item.entry.Path, item.meta?.isLocal);

    const newList = isPresent
      ? list.filter(
          i =>
            !(
              this.pathSelectionService.normalizeRemoteName(i.meta?.remote, i.meta?.isLocal) ===
                normalizedRemote && i.entry.Path === item.entry.Path
            )
        )
      : [...list, { ...item, meta: { ...item.meta, remote: normalizedRemote } }];

    config.signal.set(newList);
    this.saveCollection(type, newList);
  }

  // ========== PRIVATE HELPERS ==========

  private parseNautilusLocation(
    urlParams: URLSearchParams,
    pathName: string,
    hash: string
  ): { remoteName: string | null; remotePath: string | null } {
    const fromSegments = (input: string) => {
      const [first, ...rest] = input.split('/').filter(Boolean);
      return {
        remoteName: first ? decodeURIComponent(first) : null,
        remotePath: rest.length ? decodeURIComponent(rest.join('/')) : null,
      };
    };

    if (pathName.includes('/nautilus')) {
      const result = fromSegments(
        pathName.slice(pathName.indexOf('/nautilus') + '/nautilus'.length)
      );
      if (result.remoteName) return result;
    }

    if (hash.startsWith('#/nautilus')) {
      const result = fromSegments(hash.slice('#/nautilus'.length));
      if (result.remoteName) return result;
    }

    const browseRemote = urlParams.get('browse');
    if (browseRemote) {
      return { remoteName: browseRemote, remotePath: urlParams.get('path') };
    }

    return { remoteName: null, remotePath: null };
  }

  private setupBrowseListener(): void {
    this.eventListenersService
      .listenToBrowse()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (path: string) => {
          console.log('Browse in app event:', path);
          if (path) this.targetPath.set(path);
        },
        error: (error: unknown) => console.error('Browse in app event error:', error),
      });
  }

  private async loadCollection(type: CollectionType): Promise<void> {
    const config = this.collectionConfig[type];
    try {
      const fullKey = `${config.category}.${config.key}`;
      let rawItems = (await this.appSettingsService.getSettingValue<unknown[]>(fullKey)) ?? [];
      if (!Array.isArray(rawItems)) rawItems = [];

      const items: FileBrowserItem[] = rawItems.map((item: unknown) => {
        const rec = item as Record<string, unknown>;
        if (rec && 'remote' in rec && 'entry' in rec) {
          return {
            entry: rec['entry'] as FileBrowserItem['entry'],
            meta: {
              remote: (rec['remote'] as string) || '',
              isLocal: false,
              remoteType: undefined,
            },
          };
        }
        return rec as unknown as FileBrowserItem;
      });

      config.signal.set(items.filter(i => i.meta?.remote && i.entry?.Path));
    } catch (e) {
      console.warn(`Failed to load ${type}`, e);
    }
  }

  private saveCollection(type: CollectionType, items: FileBrowserItem[]): void {
    const { category, key } = this.collectionConfig[type];
    this.appSettingsService.saveSetting(category, key, items);
  }

  private createNautilusOverlay(
    onClose: () => void,
    showAnimation = true
  ): { overlayRef: OverlayRef; componentRef: ComponentRef<NautilusComponent> } {
    const overlayRef = this.overlay.create({
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });

    const componentRef = overlayRef.attach(new ComponentPortal(NautilusComponent));

    if (showAnimation) {
      componentRef.location.nativeElement.classList.add('slide-overlay-enter');
    }

    outputToObservable(componentRef.instance.closeOverlay).pipe(take(1)).subscribe(onClose);
    overlayRef.backdropClick().pipe(take(1)).subscribe(onClose);

    return { overlayRef, componentRef };
  }

  private createBrowserOverlay(showAnimation = true): void {
    const { overlayRef, componentRef } = this.createNautilusOverlay(
      () => this.closeBrowser(),
      showAnimation
    );
    this.browserOverlayRef = overlayRef;
    this.browserComponentRef = componentRef;
  }

  private createPickerOverlay(): void {
    const { overlayRef, componentRef } = this.createNautilusOverlay(() =>
      this.closeFilePicker(null)
    );
    this.pickerOverlayRef = overlayRef;
    this.pickerComponentRef = componentRef;
  }

  private animateAndDisposeOverlay(
    componentRef: ComponentRef<unknown> | null,
    overlayRef: OverlayRef | null
  ): void {
    componentRef?.location.nativeElement.classList.add('slide-overlay-leave');
    if (overlayRef) {
      setTimeout(() => overlayRef.dispose(), 200);
    }
  }
}

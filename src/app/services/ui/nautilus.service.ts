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
import { Subject, merge } from 'rxjs';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { take } from 'rxjs/operators';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { EventListenersService } from 'src/app/services/infrastructure/system/event-listeners.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import {
  PathNavigationService,
  NautilusLocation,
} from 'src/app/services/infrastructure/platform/path-navigation.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { takeUntilDestroyed, outputToObservable } from '@angular/core/rxjs-interop';
import {
  FileBrowserItem,
  CollectionType,
  FilePickerConfig,
  FilePickerResult,
  ExplorerRoot,
} from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { isMobile } from '../infrastructure/platform/api-client.service';
import type { NautilusComponent } from 'src/app/file-browser/nautilus/nautilus.component';

@Injectable({
  providedIn: 'root',
})
export class NautilusService extends TauriBaseService {
  private readonly overlay = inject(Overlay);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly remoteManagement = inject(RemoteManagementService);
  private readonly pathService = inject(PathService);
  private readonly pathNav = inject(PathNavigationService);
  readonly eventListenersService = inject(EventListenersService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly titleService = inject(Title);

  private readonly _filePickerState = signal<{ isOpen: boolean; options?: FilePickerConfig }>({
    isOpen: false,
  });
  readonly filePickerState = this._filePickerState.asReadonly();

  private readonly _filePickerResult = new Subject<FilePickerResult>();
  readonly filePickerResult$ = this._filePickerResult.asObservable();

  private readonly _starredItems = signal<FileBrowserItem[]>([]);
  readonly starredItems = this._starredItems.asReadonly();

  private readonly _bookmarks = signal<FileBrowserItem[]>([]);
  readonly bookmarks = this._bookmarks.asReadonly();

  readonly selectedNautilusRemote = signal<string | null>(null);
  readonly targetPath = signal<string | null>(null);

  private readonly _isStandaloneWindow = signal(false);
  readonly isStandaloneWindow = this._isStandaloneWindow.asReadonly();

  private readonly _isBrowserOverlayOpen = signal(false);
  readonly isBrowserOverlayOpen = this._isBrowserOverlayOpen.asReadonly();

  private readonly _localDrives = signal<ExplorerRoot[]>([]);
  readonly localDrives = this._localDrives.asReadonly();

  private readonly _cloudRemotes = signal<ExplorerRoot[]>([]);
  readonly cloudRemotes = this._cloudRemotes.asReadonly();

  readonly allRemotesLookup = computed(() => [...this._localDrives(), ...this._cloudRemotes()]);

  readonly starredKeys = computed(() => {
    const set = new Set<string>();
    for (const i of this._starredItems()) {
      const remote = this.pathService.normalizeRemoteName(i.meta?.remote);
      set.add(`${remote}:${i.entry.Path}`);
    }
    return set;
  });

  private pickerOverlayRef: OverlayRef | null = null;
  private pickerComponentRef: ComponentRef<NautilusComponent> | null = null;
  private isBrowserOpening = false;
  private isPickerOpening = false;

  private browserOverlayRef: OverlayRef | null = null;
  private browserComponentRef: ComponentRef<NautilusComponent> | null = null;

  private readonly collectionConfig: Record<
    CollectionType,
    {
      category: string;
      key: string;
      signal: WritableSignal<FileBrowserItem[]>;
      allowFiles: boolean;
    }
  > = {
    starred: { category: 'nautilus', key: 'starred', signal: this._starredItems, allowFiles: true },
    bookmarks: {
      category: 'nautilus',
      key: 'bookmarks',
      signal: this._bookmarks,
      allowFiles: false,
    },
  };

  constructor() {
    super();
    (Object.keys(this.collectionConfig) as CollectionType[]).forEach(type =>
      this.loadCollection(type)
    );
    this.setupBrowseListener();

    merge(
      this.eventListenersService.listenToRcloneEngineReady(),
      this.eventListenersService.listenToRemoteCacheUpdated(),
      this.eventListenersService.listenToRemoteSettingsChanged(),
      this.eventListenersService.listenToBackendSwitched()
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        void this.loadRemoteData();
      });
  }

  async loadRemoteData(): Promise<void> {
    try {
      const loadCloud = (async (): Promise<void> => {
        try {
          const [remotesRes, configsRes] = await Promise.allSettled([
            this.remoteManagement.getRemotes(),
            this.remoteManagement.getAllRemoteConfigs(),
          ]);

          const remoteNames = remotesRes.status === 'fulfilled' ? remotesRes.value : [];
          const configs =
            configsRes.status === 'fulfilled'
              ? (configsRes.value as Record<string, { type?: string; Type?: string }>)
              : {};

          if (remotesRes.status === 'rejected') {
            console.warn('[NautilusService] Failed to load remote names:', remotesRes.reason);
          }

          this._cloudRemotes.set(
            remoteNames.map(name => {
              const config = configs[name];
              return {
                name,
                label: name,
                type: config?.type ?? config?.Type ?? 'cloud',
                isLocal: false,
              };
            })
          );
        } catch (err) {
          console.warn('[NautilusService] Error loading cloud remotes:', err);
        }
      })();

      const loadDrives = (async (): Promise<void> => {
        try {
          const drives = await this.remoteManagement.getLocalDrives();
          this._localDrives.set(
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
        } catch (err) {
          console.warn('[NautilusService] Failed to load local drives:', err);
        }
      })();

      await Promise.allSettled([loadCloud, loadDrives]);
    } catch (e) {
      console.error('[NautilusService] Failed to load remote data:', e);
    }
  }

  openFromBrowseQueryParam(): void {
    const urlParams = new URLSearchParams(window.location.search);
    const pathName = window.location.pathname;
    const hash = window.location.hash;

    const tauriWin = this.getCurrentTauriWindow();
    const isStandalone =
      urlParams.get('standalone') === 'nautilus' ||
      (tauriWin?.label?.startsWith('nautilus') ?? false) ||
      pathName.includes('/nautilus') ||
      hash.startsWith('#/nautilus') ||
      urlParams.has('browse');

    this._isStandaloneWindow.set(isStandalone);

    const { remoteName, remotePath } = this.parseNautilusLocation(urlParams, pathName, hash);

    if (remoteName) {
      const remoteRoot = this.lookupRemote(remoteName);
      if (remotePath && remoteRoot) {
        this.targetPath.set(this.pathService.getFullDisplayPath(remoteRoot, remotePath));
      } else {
        this.selectedNautilusRemote.set(remoteName);
      }

      if (!isStandalone) {
        void this.newNautilusWindow(remoteName, remotePath);
      }
    }
  }

  setWindowTitle(title: string): void {
    if (this.isTauri) {
      void this.getCurrentTauriWindow()?.setTitle(title);
    }
    this.titleService.setTitle(title);
  }

  getNautilusUrl(remote: string | null, path: string | null): string {
    const remoteRoot = remote ? this.lookupRemote(remote) : null;
    const pathStyle = this.pathService.pathStyleForRemote(remoteRoot);
    return this.pathNav.buildNautilusUrl(remote, path, pathStyle);
  }

  private getNautilusLabel(remote: string | null): string {
    if (!remote) return 'nautilus';
    const slug = remote.replace(/[^a-zA-Z0-9-]/g, '_');
    return `nautilus-${slug}`;
  }

  private get isStandaloneEnabled(): boolean {
    const opts = this.appSettingsService.options();
    return this.isTauri && !isMobile() && opts?.['general.standalone_dialogs']?.value === true;
  }

  async newNautilusWindow(
    remote: string | null,
    path: string | null,
    forceStandalone = false
  ): Promise<void> {
    if (!forceStandalone && !this.isStandaloneEnabled) {
      await this.openBrowserOverlay(remote, path);
      return;
    }

    const url = this.getNautilusUrl(remote, path);
    if (this.isTauri) {
      if (isMobile()) {
        await this.openBrowserOverlay(remote, path);
        return;
      }

      const label = this.getNautilusLabel(remote);
      try {
        await this.invokeCommand('new_window', {
          opts: {
            label,
            url,
            title: 'RClone Nautilus',
            width: 1024,
            height: 768,
          },
        });
        this.closeBrowserOverlay();
      } catch (err) {
        console.warn(
          '[NautilusService] new_window command failed/unavailable, falling back to overlay:',
          err
        );
        await this.openBrowserOverlay(remote, path);
      }
    } else {
      window.open(url, '_blank');
      this.closeBrowserOverlay();
    }
  }

  async openBrowserOverlay(remote: string | null, path: string | null): Promise<void> {
    if (this.browserOverlayRef) {
      if (remote) {
        const remoteRoot = this.lookupRemoteByName(remote);
        if (path && remoteRoot) {
          this.targetPath.set(this.pathService.getFullDisplayPath(remoteRoot, path));
        } else {
          this.selectedNautilusRemote.set(remote);
        }
      }
      return;
    }
    if (this.isBrowserOpening) return;
    this.isBrowserOpening = true;

    if (remote) {
      const remoteRoot = this.lookupRemoteByName(remote);
      if (path && remoteRoot) {
        this.targetPath.set(this.pathService.getFullDisplayPath(remoteRoot, path));
      } else {
        this.selectedNautilusRemote.set(remote);
      }
    }

    try {
      const { NautilusComponent } =
        await import('src/app/file-browser/nautilus/nautilus.component');
      const { overlayRef, componentRef } = this.createNautilusOverlay(NautilusComponent, () =>
        this.closeBrowserOverlay()
      );
      this.browserOverlayRef = overlayRef;
      this.browserComponentRef = componentRef;
      this._isBrowserOverlayOpen.set(true);
    } catch (err) {
      console.error('[NautilusService] Failed to open browser overlay:', err);
      this._isBrowserOverlayOpen.set(false);
    } finally {
      this.isBrowserOpening = false;
    }
  }

  closeBrowserOverlay(): void {
    this._isBrowserOverlayOpen.set(false);
    this.animateAndDisposeOverlay(this.browserComponentRef, this.browserOverlayRef);
    this.browserComponentRef = null;
    this.browserOverlayRef = null;
  }

  toggleNautilusOverlay(remote: string | null = null, path: string | null = null): void {
    if (this._isBrowserOverlayOpen()) {
      this.closeBrowserOverlay();
    } else {
      void this.newNautilusWindow(remote, path);
    }
  }

  openForRemote(remoteName: string): void {
    void this.newNautilusWindow(remoteName, null);
  }

  openPath(path: string): void {
    const { remote, path: relativePath } = this.pathService.splitFsPath(path);
    void this.newNautilusWindow(remote || null, relativePath || null);
  }

  async openFilePicker(options: FilePickerConfig): Promise<void> {
    if (this.pickerOverlayRef || this.isPickerOpening) return;
    this.isPickerOpening = true;
    try {
      this._filePickerState.set({
        isOpen: true,
        options: { ...options, requestId: options.requestId ?? crypto.randomUUID() },
      });
      await this.createPickerOverlay();
    } catch (err) {
      console.error('[NautilusService] Failed to open file picker:', err);
      this._filePickerState.set({ isOpen: false });
    } finally {
      this.isPickerOpening = false;
    }
  }

  closeFilePicker(result: FileBrowserItem[] | null): void {
    const requestId = this._filePickerState().options?.requestId;
    const items = result ?? [];

    this._filePickerResult.next({
      cancelled: result === null,
      items,
      paths: items.map(i => {
        const remoteRoot = this.lookupRemote(i.meta.remote);
        return this.pathService.getFullDisplayPath(
          remoteRoot ?? {
            name: i.meta.remote,
            isLocal: i.meta.isLocal,
            label: i.meta.remote,
            type: i.meta.remoteType ?? '',
          },
          i.entry.Path
        );
      }),
      requestId,
    });

    this._filePickerState.set({ isOpen: false });
    this.animateAndDisposeOverlay(this.pickerComponentRef, this.pickerOverlayRef);
    this.pickerComponentRef = null;
    this.pickerOverlayRef = null;
  }

  closeBrowser(): void {
    if (this._isStandaloneWindow()) {
      this.getCurrentTauriWindow()?.close();
    }
  }

  isSaved(type: CollectionType, remote: string, path: string): boolean {
    if (type === 'starred') {
      const cleanRemote = this.pathService.normalizeRemoteName(remote);
      return this.starredKeys().has(`${cleanRemote}:${path}`);
    }
    const cleanRemote = this.pathService.normalizeRemoteName(remote);
    return this.collectionConfig[type]
      .signal()
      .some(
        i =>
          this.pathService.normalizeRemoteName(i.meta?.remote) === cleanRemote &&
          i.entry.Path === path
      );
  }

  toggleItem(type: CollectionType, item: FileBrowserItem): void {
    const config = this.collectionConfig[type];

    if (!config.allowFiles && !item.entry.IsDir) {
      console.warn(`Cannot add a file to the ${type} collection`);
      return;
    }

    const normalizedRemote = this.pathService.normalizeRemoteName(item.meta?.remote ?? '');
    const list = config.signal();
    const isPresent = this.isSaved(type, normalizedRemote, item.entry.Path);

    const newList = isPresent
      ? list.filter(
          i =>
            !(
              this.pathService.normalizeRemoteName(i.meta?.remote) === normalizedRemote &&
              i.entry.Path === item.entry.Path
            )
        )
      : [...list, { ...item, meta: { ...item.meta, remote: normalizedRemote } }];

    config.signal.set(newList);
    this.saveCollection(type, newList);
  }

  private parseNautilusLocation(
    urlParams: URLSearchParams,
    pathName: string,
    hash: string
  ): { remoteName: string | null; remotePath: string | null } {
    const firstPass: NautilusLocation = this.pathNav.parseLocation(urlParams, pathName, hash);
    if (!firstPass.remote) {
      return { remoteName: null, remotePath: null };
    }
    const remoteRoot = this.lookupRemote(firstPass.remote);
    const pathStyle = this.pathService.pathStyleForRemote(remoteRoot);
    if (pathStyle === 'posix') {
      return { remoteName: firstPass.remote, remotePath: firstPass.path };
    }
    const loc: NautilusLocation = this.pathNav.parseLocation(urlParams, pathName, hash, pathStyle);
    return { remoteName: loc.remote, remotePath: loc.path };
  }

  /**
   * Resolve a parsed remote name to its `ExplorerRoot` from the engine-populated
   * registry (local drives + cloud remotes). Returns `null` if the remote is
   * not currently registered.
   */
  lookupRemoteByName(remoteName: string): ExplorerRoot | null {
    const all = this.allRemotesLookup();
    const byName = all.find(r => r.name === remoteName);
    if (byName) return byName;
    const normalized = this.pathService.normalizeRemoteName(remoteName);
    return all.find(r => this.pathService.normalizeRemoteName(r.name) === normalized) ?? null;
  }

  private lookupRemote(remoteName: string): ExplorerRoot | null {
    return this.lookupRemoteByName(remoteName);
  }

  private setupBrowseListener(): void {
    this.eventListenersService
      .listenToBrowse()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (path: string) => {
          if (path) {
            if (this._isStandaloneWindow()) {
              this.targetPath.set(path);
            } else {
              const { remote, path: relativePath } = this.pathService.splitFsPath(path);
              void this.newNautilusWindow(remote || null, relativePath || null);
            }
          }
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

      const items: FileBrowserItem[] = [];
      for (const item of rawItems) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        if (rec['entry'] && typeof rec['entry'] === 'object') {
          const entry = rec['entry'] as Record<string, unknown>;
          if (typeof entry['Path'] === 'string' && typeof entry['Name'] === 'string') {
            const meta = (rec['meta'] ?? {}) as Record<string, unknown>;
            items.push({
              entry: entry as unknown as FileBrowserItem['entry'],
              meta: {
                remote: (meta['remote'] as string) || (rec['remote'] as string) || '',
                isLocal: meta['isLocal'] === true,
                remoteType: meta['remoteType'] as string | undefined,
              },
            });
          }
        }
      }

      config.signal.set(items.filter(i => i.meta?.remote && i.entry?.Path));
    } catch (e) {
      console.warn(`Failed to load ${type}`, e);
    }
  }

  private saveCollection(type: CollectionType, items: FileBrowserItem[]): void {
    const { category, key } = this.collectionConfig[type];
    this.appSettingsService.saveSetting(category, key, items);
  }

  isSendToRegistered(remote: string, path: string | null): Promise<boolean> {
    return this.invokeCommand<boolean>('is_send_to_registered', { remote, path }).catch(
      () => false
    );
  }

  registerSendTo(remote: string, path: string | null): Promise<void> {
    return this.invokeCommand<void>('register_send_to', { remote, path });
  }

  unregisterSendTo(remote: string, path: string | null): Promise<void> {
    return this.invokeCommand<void>('unregister_send_to', { remote, path });
  }

  private createNautilusOverlay<T = unknown>(
    componentClass: typeof NautilusComponent,
    onClose: (result?: T) => void,
    showAnimation = true
  ): { overlayRef: OverlayRef; componentRef: ComponentRef<NautilusComponent> } {
    const overlayRef = this.overlay.create({
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });

    const componentRef = overlayRef.attach(new ComponentPortal(componentClass));

    if (showAnimation) {
      componentRef.location.nativeElement.classList.add('slide-overlay-enter');
    }

    outputToObservable(componentRef.instance.closeOverlay)
      .pipe(take(1))
      .subscribe(res => onClose(res as T));
    overlayRef
      .backdropClick()
      .pipe(take(1))
      .subscribe(() => onClose());

    return { overlayRef, componentRef };
  }

  private async createPickerOverlay(): Promise<void> {
    const { NautilusComponent } = await import('src/app/file-browser/nautilus/nautilus.component');
    const { overlayRef, componentRef } = this.createNautilusOverlay<FileBrowserItem[] | null>(
      NautilusComponent,
      items => this.closeFilePicker(items ?? null)
    );
    this.pickerOverlayRef = overlayRef;
    this.pickerComponentRef = componentRef;
  }

  private animateAndDisposeOverlay(
    componentRef: ComponentRef<unknown> | null,
    overlayRef: OverlayRef | null
  ): void {
    if (!overlayRef) return;
    const element = componentRef?.location?.nativeElement as HTMLElement | undefined;
    if (element) {
      element.classList.add('slide-overlay-leave');
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onEnd = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        element.removeEventListener('animationend', onEnd);
        if (overlayRef.hasAttached()) {
          overlayRef.dispose();
        }
      };
      element.addEventListener('animationend', onEnd);
      timer = setTimeout(() => {
        element.removeEventListener('animationend', onEnd);
        if (overlayRef.hasAttached()) {
          overlayRef.dispose();
        }
      }, 250);
    } else {
      if (overlayRef.hasAttached()) {
        overlayRef.dispose();
      }
    }
  }
}

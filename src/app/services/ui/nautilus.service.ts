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
import { Observable, Subject, merge } from 'rxjs';
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
import { UiStateService } from './state/ui-state.service';
import { isMobile } from '../infrastructure/platform/api-client.service';

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
  private readonly uiState = inject(UiStateService);

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

  private readonly _localDrives = signal<ExplorerRoot[]>([]);
  readonly localDrives = this._localDrives.asReadonly();

  private readonly _cloudRemotes = signal<ExplorerRoot[]>([]);
  readonly cloudRemotes = this._cloudRemotes.asReadonly();

  readonly allRemotesLookup = computed(() => [...this._localDrives(), ...this._cloudRemotes()]);

  readonly starredKeys = computed(() => {
    const set = new Set<string>();
    for (const i of this._starredItems()) {
      const remote = this.pathService.normalizeRemoteName(i.meta?.remote, i.meta?.isLocal);
      set.add(`${remote}:${i.entry.Path}`);
    }
    return set;
  });

  private pickerOverlayRef: OverlayRef | null = null;
  private pickerComponentRef: ComponentRef<any> | null = null;

  private browserOverlayRef: OverlayRef | null = null;
  private browserComponentRef: ComponentRef<any> | null = null;

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
      this.eventListenersService.listenToRemoteSettingsChanged()
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        void this.loadRemoteData();
      });
  }

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

      this._cloudRemotes.set(
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
      if (remotePath) {
        const isLocal =
          remoteName.startsWith('/') || (remoteName.length >= 2 && remoteName[1] === ':');
        this.targetPath.set(
          this.pathService.getFullDisplayPath({ name: remoteName, isLocal } as any, remotePath)
        );
      } else {
        this.selectedNautilusRemote.set(remoteName);
      }

      if (!isStandalone) {
        void this.newNautilusWindow(remoteName, remotePath);
      }
    }
  }

  setWindowTitle(title: string): void {
    setTimeout(async () => {
      if (this.isTauri) {
        await this.getCurrentTauriWindow()?.setTitle(title);
      }
      this.titleService.setTitle(title);
    }, 0);
  }

  getNautilusUrl(remote: string | null, path: string | null): string {
    return this.pathNav.buildNautilusUrl(remote, path);
  }

  private getNautilusLabel(remote: string | null): string {
    if (!remote) return 'nautilus';
    const slug = remote.replace(/[^a-zA-Z0-9-]/g, '_');
    return `nautilus-${slug}`;
  }

  async newNautilusWindow(remote: string | null, path: string | null): Promise<void> {
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
      } catch (err) {
        console.warn(
          '[NautilusService] new_window command failed/unavailable, falling back to overlay:',
          err
        );
        await this.openBrowserOverlay(remote, path);
      }
    } else {
      window.open(url, '_blank');
    }
  }

  async openBrowserOverlay(remote: string | null, path: string | null): Promise<void> {
    if (this.browserOverlayRef) return;

    if (remote) {
      if (path) {
        const isLocal = remote.startsWith('/') || (remote.length >= 2 && remote[1] === ':');
        this.targetPath.set(
          this.pathService.getFullDisplayPath({ name: remote, isLocal } as any, path)
        );
      } else {
        this.selectedNautilusRemote.set(remote);
      }
    }

    const { NautilusComponent } = await import('src/app/file-browser/nautilus/nautilus.component');
    const { overlayRef, componentRef } = this.createNautilusOverlay(NautilusComponent, () =>
      this.closeBrowserOverlay()
    );
    this.browserOverlayRef = overlayRef;
    this.browserComponentRef = componentRef;
  }

  closeBrowserOverlay(): void {
    this.animateAndDisposeOverlay(this.browserComponentRef, this.browserOverlayRef);
    this.browserComponentRef = null;
    this.browserOverlayRef = null;
  }

  openForRemote(remoteName: string): void {
    void this.newNautilusWindow(remoteName, null);
  }

  openPath(path: string): void {
    const { remote, path: relativePath } = this.pathService.splitFsPath(path);
    void this.newNautilusWindow(remote || null, relativePath || null);
  }

  async openFilePicker(options: FilePickerConfig): Promise<void> {
    if (this.pickerOverlayRef) return;
    this._filePickerState.set({
      isOpen: true,
      options: { ...options, requestId: options.requestId ?? crypto.randomUUID() },
    });
    await this.createPickerOverlay();
  }

  closeFilePicker(result: FileBrowserItem[] | null): void {
    const requestId = this._filePickerState().options?.requestId;
    const items = result ?? [];

    this._filePickerResult.next({
      cancelled: result === null,
      items,
      paths: items.map(i => {
        return this.pathService.getFullDisplayPath(
          { name: i.meta.remote, isLocal: i.meta.isLocal } as any,
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

  isSaved(type: CollectionType, remote: string, path: string, isLocal = false): boolean {
    if (type === 'starred') {
      const cleanRemote = this.pathService.normalizeRemoteName(remote, isLocal);
      return this.starredKeys().has(`${cleanRemote}:${path}`);
    }
    const cleanRemote = this.pathService.normalizeRemoteName(remote, isLocal);
    return this.collectionConfig[type]
      .signal()
      .some(
        i =>
          this.pathService.normalizeRemoteName(i.meta?.remote, i.meta?.isLocal) === cleanRemote &&
          i.entry.Path === path
      );
  }

  toggleItem(type: CollectionType, item: FileBrowserItem): void {
    const config = this.collectionConfig[type];

    if (!config.allowFiles && !item.entry.IsDir) {
      console.warn(`Cannot add a file to the ${type} collection`);
      return;
    }

    const normalizedRemote = this.pathService.normalizeRemoteName(
      item.meta?.remote ?? '',
      item.meta?.isLocal
    );
    const list = config.signal();
    const isPresent = this.isSaved(type, normalizedRemote, item.entry.Path, item.meta?.isLocal);

    const newList = isPresent
      ? list.filter(
          i =>
            !(
              this.pathService.normalizeRemoteName(i.meta?.remote, i.meta?.isLocal) ===
                normalizedRemote && i.entry.Path === item.entry.Path
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
    const loc: NautilusLocation = this.pathNav.parseLocation(urlParams, pathName, hash);
    return { remoteName: loc.remote, remotePath: loc.path };
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

  private createNautilusOverlay(
    componentClass: any,
    onClose: () => void,
    showAnimation = true
  ): { overlayRef: OverlayRef; componentRef: ComponentRef<any> } {
    const overlayRef = this.overlay.create({
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });

    const componentRef = overlayRef.attach(
      new ComponentPortal(componentClass)
    ) as ComponentRef<any>;

    if (showAnimation) {
      componentRef.location.nativeElement.classList.add('slide-overlay-enter');
    }

    outputToObservable(componentRef.instance.closeOverlay).pipe(take(1)).subscribe(onClose);
    overlayRef.backdropClick().pipe(take(1)).subscribe(onClose);

    return { overlayRef, componentRef };
  }

  private async createPickerOverlay(): Promise<void> {
    const { NautilusComponent } = await import('src/app/file-browser/nautilus/nautilus.component');

    const overlayRef = this.overlay.create({
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });

    const componentRef = overlayRef.attach(
      new ComponentPortal(NautilusComponent)
    ) as ComponentRef<any>;

    componentRef.location.nativeElement.classList.add('slide-overlay-enter');

    // When the picker confirms a selection, it emits the chosen items via closeOverlay
    (outputToObservable(componentRef.instance.closeOverlay) as Observable<FileBrowserItem[] | null>)
      .pipe(take(1))
      .subscribe(items => this.closeFilePicker(items ?? null));

    // Clicking the backdrop (outside the picker) cancels the selection
    overlayRef
      .backdropClick()
      .pipe(take(1))
      .subscribe(() => this.closeFilePicker(null));

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

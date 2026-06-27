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
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import {
  ModalService,
  RemoteConfigModalOptions,
  ExportModalOptions,
  PropertiesModalOptions,
  RemoteAboutModalOptions,
} from 'src/app/services/ui/modal.service';
import { EventListenersService } from 'src/app/services/infrastructure/system/event-listeners.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
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

@Injectable({
  providedIn: 'root',
})
export class NautilusService extends TauriBaseService {
  private readonly overlay = inject(Overlay);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly remoteManagement = inject(RemoteManagementService);
  private readonly pathService = inject(PathService);
  readonly eventListenersService = inject(EventListenersService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly titleService = inject(Title);
  private readonly modalService = inject(ModalService);

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

  private pickerOverlayRef: OverlayRef | null = null;
  private pickerComponentRef: ComponentRef<any> | null = null;

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
    let url = `${window.location.origin}/nautilus`;
    if (remote) {
      url += `/${encodeURIComponent(remote)}`;
      if (path) {
        url += `/${this.pathService.encodePath(path, false)}`;
      }
    }
    return url;
  }

  private getNautilusLabel(remote: string | null): string {
    if (!remote) return 'nautilus';
    const slug = remote.replace(/[^a-zA-Z0-9-]/g, '_');
    return `nautilus-${slug}`;
  }

  async newNautilusWindow(remote: string | null, path: string | null): Promise<void> {
    const url = this.getNautilusUrl(remote, path);
    if (this.isTauri) {
      const label = this.getNautilusLabel(remote);
      await this.invokeCommand('new_window', {
        opts: {
          label,
          url,
          title: 'RClone Nautilus',
          width: 1024,
          height: 768,
        },
      });
    } else {
      window.open(url, '_blank');
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
    const fromSegments = (
      input: string
    ): { remoteName: string | null; remotePath: string | null } => {
      const [first, ...rest] = this.pathService.splitSegments(input);
      const decodedFirst = first ? decodeURIComponent(first) : null;

      if (
        decodedFirst &&
        (decodedFirst.startsWith('/') || /^[a-zA-Z]:/.test(decodedFirst)) &&
        this.pathService.splitSegments(decodedFirst).length > 1
      ) {
        const parsed = this.pathService.parseLocation(decodedFirst, this.allRemotesLookup());
        if (parsed) {
          return {
            remoteName: parsed.remote.name,
            remotePath: parsed.path,
          };
        }
      }

      return {
        remoteName: decodedFirst,
        remotePath: rest.length ? this.pathService.decodePath(rest.join('/')) : null,
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

  openProperties(options: PropertiesModalOptions): any {
    return this.modalService.openProperties(options);
  }

  openExport(options: ExportModalOptions): any {
    return this.modalService.openExport(options);
  }

  openLogs(remoteName: string): any {
    return this.modalService.openLogs(remoteName);
  }

  openRemoteConfig(options: RemoteConfigModalOptions): any {
    return this.modalService.openRemoteConfig(options);
  }

  openQuickAddRemote(): any {
    return this.modalService.openQuickAddRemote();
  }

  openArchiveCreate(data: any): any {
    return this.modalService.openArchiveCreate(data);
  }

  openRemoteAbout(options: RemoteAboutModalOptions): any {
    return this.modalService.openRemoteAbout(options);
  }

  openKeyboardShortcuts(data?: { nautilus?: boolean }): any {
    return this.modalService.openKeyboardShortcuts(data);
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
    const { overlayRef, componentRef } = this.createNautilusOverlay(NautilusComponent, () =>
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

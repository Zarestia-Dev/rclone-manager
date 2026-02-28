import {
  ComponentRef,
  DestroyRef,
  inject,
  Injectable,
  signal,
  computed,
  WritableSignal,
} from '@angular/core';
import { Subject } from 'rxjs';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { take } from 'rxjs/operators';
import { NautilusComponent } from 'src/app/features/components/file-browser/nautilus/nautilus.component';
import {
  AppSettingsService,
  EventListenersService,
  PathSelectionService,
  RemoteManagementService,
} from '@app/services';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
export class NautilusService {
  private overlay = inject(Overlay);
  private appSettingsService = inject(AppSettingsService);
  private remoteManagement = inject(RemoteManagementService);
  private pathSelectionService = inject(PathSelectionService);
  private eventListenersService = inject(EventListenersService);
  private destroyRef = inject(DestroyRef);

  // Nautilus / Browser overlay
  private readonly _isNautilusOverlayOpen = signal<boolean>(false);
  public readonly isNautilusOverlayOpen = this._isNautilusOverlayOpen.asReadonly();

  // File Picker state
  private readonly _filePickerState = signal<{
    isOpen: boolean;
    options?: FilePickerConfig;
  }>({ isOpen: false });
  public readonly filePickerState = this._filePickerState.asReadonly();
  private _filePickerResult = new Subject<FilePickerResult>();
  public filePickerResult$ = this._filePickerResult.asObservable();

  // Public Signals (Read by UI)
  public readonly starredItems = signal<FileBrowserItem[]>([]);
  public readonly bookmarks = signal<FileBrowserItem[]>([]);

  // Selected remote signal (for initial navigation or direct selection)
  public readonly selectedNautilusRemote = signal<string | null>(null);

  // Target path for opening specific folders (e.g. from debug menu)
  public readonly targetPath = signal<string | null>(null);

  // ========== REMOTE/DRIVE STATE ==========

  // Simple writable signals for drives and remotes
  public readonly localDrives = signal<ExplorerRoot[]>([]);
  public readonly cloudRemotes = signal<ExplorerRoot[]>([]);

  // Combined lookup
  public readonly allRemotesLookup = computed(() => [
    ...this.localDrives(),
    ...this.cloudRemotes(),
  ]);

  // Load data when Nautilus opens
  public async loadRemoteData(): Promise<void> {
    const [remoteNames, drives, configs] = await Promise.all([
      this.remoteManagement.getRemotes(),
      this.remoteManagement.getLocalDrives(),
      this.remoteManagement.getAllRemoteConfigs().catch(() => ({})),
    ]);

    // Set local drives
    this.localDrives.set(
      drives.map(drive => ({
        name: drive.name,
        label: drive.label || drive.name,
        type: 'hard-drive',
        isLocal: true,
        showName: drive.show_name,
      }))
    );

    // Set cloud remotes
    this.cloudRemotes.set(
      remoteNames.map(name => {
        const config = (configs as Record<string, { type?: string; Type?: string } | undefined>)[
          name
        ];
        return {
          name,
          label: name,
          type: config?.type || config?.Type || 'cloud',
          isLocal: false, // Will be updated from fsInfo cache later if needed
        };
      })
    );
  }

  // ========== COLLECTIONS CONFIG ==========

  private readonly collections: Record<
    CollectionType,
    {
      category: string;
      key: string;
      signal: WritableSignal<FileBrowserItem[]>;
      allowFiles: boolean;
    }
  > = {
    starred: {
      category: 'nautilus',
      key: 'starred',
      signal: this.starredItems,
      allowFiles: true,
    },
    bookmarks: {
      category: 'nautilus',
      key: 'bookmarks',
      signal: this.bookmarks,
      allowFiles: false,
    },
  };

  // Browser overlay (full-screen file browser)
  private browserOverlayRef: OverlayRef | null = null;
  private browserComponentRef: ComponentRef<NautilusComponent> | null = null;

  // Picker overlay (modal dialog for file/folder selection)
  private pickerOverlayRef: OverlayRef | null = null;
  private pickerComponentRef: ComponentRef<NautilusComponent> | null = null;

  constructor() {
    // Load all collections dynamically
    (Object.keys(this.collections) as CollectionType[]).forEach(type => {
      this.loadCollection(type);
    });

    this.setupBrowseListener();
  }

  toggleNautilusOverlay(): void {
    if (this.browserOverlayRef) {
      this.createBrowserOverlay();
    } else {
      this._isNautilusOverlayOpen.set(true);
      this.createBrowserOverlay();
    }
  }

  /**
   * Check for ?browse=remoteName URL parameter and open in-app browser
   * This is triggered from the tray menu when "Browse (In App)" is clicked
   */
  openFromBrowseQueryParam(): void {
    const urlParams = new URLSearchParams(window.location.search);
    const browseRemote = urlParams.get('browse');

    if (!browseRemote) {
      return;
    }

    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
    // Skip entrance animation when opening via deep link
    this.openForRemote(browseRemote, false);
  }

  /**
   * Opens the file browser and navigates to a specific remote.
   * If already open, just navigates without reinitializing.
   * @param showAnimation - If true, shows the entrance animation (useful for deep links)
   */
  openForRemote(remoteName: string, showAnimation = true): void {
    this.selectedNautilusRemote.set(remoteName);

    if (this.browserOverlayRef) {
      return;
    }

    // Not open - create the overlay
    this._isNautilusOverlayOpen.set(true);
    this.createBrowserOverlay(showAnimation);
  }

  /**
   * Opens the file browser and navigates to a specific absolute path.
   * Use this for opening specific folders (logs, config, etc.)
   */
  openPath(path: string, showAnimation = true): void {
    this.targetPath.set(path);

    if (this.browserOverlayRef) {
      // If already open, the effect in NautilusComponent should handle the signal change
      // But we can double check logic there.
      return;
    }

    // Not open - create the overlay
    this._isNautilusOverlayOpen.set(true);
    this.createBrowserOverlay(showAnimation);
  }

  /**
   * Opens the file picker as a modal dialog.
   * Can be opened even when Nautilus browser is already open.
   */
  openFilePicker(options: FilePickerConfig): void {
    // Already has a picker open
    if (this.pickerOverlayRef) return;
    const requestId = options.requestId ?? this.createRequestId();
    const optionsWithId: FilePickerConfig = { ...options, requestId };

    this._filePickerState.set({ isOpen: true, options: optionsWithId });
    this.createPickerOverlay();
  }

  /**
   * Closes the file picker and returns the result.
   */
  closeFilePicker(result: FileBrowserItem[] | null): void {
    const requestId = this._filePickerState().options?.requestId;
    const items = result ?? [];

    const config: FilePickerResult = {
      cancelled: result === null,
      items: items,
      paths: items.map(i => {
        const prefix = !i.meta.isLocal
          ? this.pathSelectionService.normalizeRemoteForRclone(i.meta.remote ?? '')
          : i.meta.remote;
        if (i.meta.isLocal) {
          const sep = prefix?.endsWith('/') ? '' : '/';
          return `${prefix}${sep}${i.entry.Path}`;
        }
        return `${prefix}${i.entry.Path}`;
      }),
      requestId,
    };
    this._filePickerResult.next(config);
    this._filePickerState.set({ isOpen: false });

    if (this.pickerComponentRef) {
      this.pickerComponentRef.location.nativeElement.classList.add('slide-overlay-leave');
    }
    if (this.pickerOverlayRef) {
      setTimeout(() => {
        this.pickerOverlayRef?.dispose();
        this.pickerOverlayRef = null;
        this.pickerComponentRef = null;
      }, 200);
    }
  }

  /**
   * Closes the Nautilus browser overlay.
   */
  closeBrowser(): void {
    this._isNautilusOverlayOpen.set(false);

    if (this.browserComponentRef) {
      this.browserComponentRef.location.nativeElement.classList.add('slide-overlay-leave');
    }
    if (this.browserOverlayRef) {
      setTimeout(() => {
        this.browserOverlayRef?.dispose();
        this.browserOverlayRef = null;
        this.browserComponentRef = null;
      }, 200);
    }
  }

  private setupBrowseListener(): void {
    this.eventListenersService
      .listenToOpenInternalRoute()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (remoteName: string) => {
          console.debug(`📂 Browse event received for remote: ${remoteName}`);
          this.openForRemote(remoteName);
        },
        error: error => console.error('Browse in app event error:', error),
      });
  }

  private createRequestId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    const suffix = Math.random().toString(36).slice(2, 10);
    return `picker_${Date.now()}_${suffix}`;
  }

  // --- Generic Public Methods ---

  /**
   * Checks if an item exists in a specific collection.
   */
  public isSaved(type: CollectionType, remote: string, path: string, isLocal = false): boolean {
    const list = this.collections[type].signal();
    // Normalize remote string using centralized service
    const cleanRemote = this.pathSelectionService.normalizeRemoteName(remote, isLocal);
    return list.some(
      i =>
        this.pathSelectionService.normalizeRemoteName(i.meta?.remote, i.meta?.isLocal) ===
          cleanRemote && i.entry.Path === path
    );
  }

  /**
   * Toggles an item in a collection.
   * Handles Add/Remove automatically.
   */
  public toggleItem(type: CollectionType, item: FileBrowserItem): void {
    const config = this.collections[type];

    // 1. Validation: Check folder restriction
    if (!config.allowFiles && !item.entry.IsDir) {
      console.warn(`Cannot add file to ${type} collection`);
      return;
    }

    // 2. FUTURE-PROOFING: Normalize the remote name here (single source of truth)
    // Ensure the incoming item's meta.remote is normalized correctly.
    if (item?.meta?.remote && typeof item.meta.remote === 'string') {
      item.meta.remote = this.pathSelectionService.normalizeRemoteName(
        item.meta.remote,
        item.meta.isLocal
      );
    }

    const list = config.signal();
    const isPresent = this.isSaved(type, item.meta.remote, item.entry.Path, item.meta.isLocal);
    let newList: FileBrowserItem[];

    if (isPresent) {
      // Remove matching items. Compare normalized remote names using centralized logic.
      newList = list.filter(
        i =>
          !(
            this.pathSelectionService.normalizeRemoteName(i.meta?.remote, i.meta?.isLocal) ===
              this.pathSelectionService.normalizeRemoteName(
                item.meta?.remote,
                item.meta?.isLocal
              ) && i.entry.Path === item.entry.Path
          )
      );
    } else {
      // Add: store a normalized copy to guarantee consistency in persisted data.
      const itemToSave: FileBrowserItem = {
        ...item,
        meta: {
          ...(item.meta || {}),
          remote: this.pathSelectionService.normalizeRemoteName(
            item.meta?.remote || '',
            item.meta?.isLocal
          ),
        },
      };
      newList = [...list, itemToSave];
    }

    // Update State & Persist
    config.signal.set(newList);
    this.saveCollection(type, newList);
  }

  // --- Internal Helpers ---

  private async loadCollection(type: CollectionType): Promise<void> {
    const config = this.collections[type];
    try {
      const fullKey = `${config.category}.${config.key}`;
      let rawItems = (await this.appSettingsService.getSettingValue<unknown[]>(fullKey)) ?? [];
      if (!Array.isArray(rawItems)) {
        rawItems = [];
      }
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
        // Otherwise assume item is already in the new composed FileBrowserItem format
        return rec as unknown as FileBrowserItem;
      });
      // Simple validation to ensure data integrity
      const validItems = items.filter(i => i.meta?.remote && i.entry?.Path);
      config.signal.set(validItems);
    } catch (e) {
      console.warn(`Failed to load ${type}`, e);
    }
  }

  private saveCollection(type: CollectionType, items: FileBrowserItem[]): void {
    const config = this.collections[type];
    this.appSettingsService.saveSetting(config.category, config.key, items);
  }

  /**
   * Creates the full-screen Nautilus browser overlay.
   */
  private createBrowserOverlay(showAnimation = true): void {
    this.browserOverlayRef = this.overlay.create({
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });

    const portal = new ComponentPortal(NautilusComponent);
    const componentRef: ComponentRef<NautilusComponent> = this.browserOverlayRef.attach(portal);
    this.browserComponentRef = componentRef;

    // Skip entrance animation for deep links / URL parameters
    if (showAnimation) {
      componentRef.location.nativeElement.classList.add('slide-overlay-enter');
    }

    componentRef.instance.closeOverlay.pipe(take(1)).subscribe(() => {
      this.closeBrowser();
    });

    this.browserOverlayRef
      .backdropClick()
      .pipe(take(1))
      .subscribe(() => {
        this.closeBrowser();
      });
  }

  /**
   * Creates the file picker modal overlay (can be opened over the browser).
   */
  private createPickerOverlay(): void {
    this.pickerOverlayRef = this.overlay.create({
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });

    const portal = new ComponentPortal(NautilusComponent);
    const componentRef: ComponentRef<NautilusComponent> = this.pickerOverlayRef.attach(portal);
    this.pickerComponentRef = componentRef;

    componentRef.location.nativeElement.classList.add('slide-overlay-enter');

    componentRef.instance.closeOverlay.pipe(take(1)).subscribe(() => {
      this.closeFilePicker(null);
    });

    this.pickerOverlayRef
      .backdropClick()
      .pipe(take(1))
      .subscribe(() => {
        this.closeFilePicker(null);
      });
  }
}

import { ComponentRef, inject, Injectable, signal, computed, WritableSignal } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { take } from 'rxjs/operators';
import { NautilusComponent } from 'src/app/features/components/file-browser/nautilus/nautilus.component';
import { AppSettingsService, RemoteManagementService } from '@app/services';
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

  // Nautilus / Browser overlay
  private _isNautilusOverlayOpen = new BehaviorSubject<boolean>(false);
  public isNautilusOverlayOpen$ = this._isNautilusOverlayOpen.asObservable();

  public get isNautilusOverlayOpen(): boolean {
    return this._isNautilusOverlayOpen.getValue();
  }

  // File Picker state
  private _filePickerState = new BehaviorSubject<{
    isOpen: boolean;
    options?: FilePickerConfig;
  }>({ isOpen: false });
  public filePickerState$ = this._filePickerState.asObservable();
  private _filePickerResult = new Subject<FilePickerResult>();
  public filePickerResult$ = this._filePickerResult.asObservable();

  // Public Signals (Read by UI)
  public readonly starredItems = signal<FileBrowserItem[]>([]);
  public readonly bookmarks = signal<FileBrowserItem[]>([]);

  // Selected remote signal (for initial navigation or direct selection)
  public readonly selectedNautilusRemote = signal<string | null>(null);

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
        fs_type: 'local' as const,
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
          fs_type: 'remote' as const,
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

  private overlayRef: OverlayRef | null = null;
  private componentRef: ComponentRef<NautilusComponent> | null = null;

  constructor() {
    // Load all collections dynamically
    (Object.keys(this.collections) as CollectionType[]).forEach(type => {
      this.loadCollection(type);
    });
  }

  toggleNautilusOverlay(): void {
    if (this.overlayRef) {
      this.closeFilePicker(null);
    } else {
      this._filePickerState.next({ isOpen: false });
      this._isNautilusOverlayOpen.next(true);
      this.createNautilusOverlay();
    }
  }

  /**
   * Opens the file browser and navigates to a specific remote.
   * If already open, just navigates without reinitializing.
   * @param showAnimation - If true, shows the entrance animation (useful for deep links)
   */
  openForRemote(remoteName: string, showAnimation = true): void {
    this.selectedNautilusRemote.set(remoteName);

    if (this.overlayRef) {
      return;
    }

    // Not open - create the overlay
    this._filePickerState.next({ isOpen: false });
    this._isNautilusOverlayOpen.next(true);
    this.createNautilusOverlay(showAnimation);
  }

  openFilePicker(options: FilePickerConfig): void {
    if (this.overlayRef) return;
    this._filePickerState.next({ isOpen: true, options });
    this._isNautilusOverlayOpen.next(true);
    this.createNautilusOverlay();
  }

  closeFilePicker(result: string[] | null): void {
    const config: FilePickerResult = {
      cancelled: result === null,
      paths: result ?? [],
    };
    this._filePickerResult.next(config);
    this._filePickerState.next({ isOpen: false });
    this._isNautilusOverlayOpen.next(false);
    if (this.componentRef) {
      this.componentRef.location.nativeElement.classList.add('slide-overlay-leave');
    }
    if (this.overlayRef) {
      setTimeout(() => {
        this.overlayRef?.dispose();
        this.overlayRef = null;
        this.componentRef = null;
      }, 200);
    }
  }

  // --- Generic Public Methods ---

  /**
   * Checks if an item exists in a specific collection.
   */
  public isSaved(type: CollectionType, remote: string, path: string): boolean {
    const list = this.collections[type].signal();
    // Normalize remote string just in case
    const cleanRemote = remote.replace(/:$/, '');
    return list.some(
      i => i.meta?.remote.replace(/:$/, '') === cleanRemote && i.entry.Path === path
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
    // Ensure the incoming item's meta.remote never contains a trailing colon.
    if (item?.meta?.remote && typeof item.meta.remote === 'string') {
      item.meta.remote = item.meta.remote.replace(/:$/, '');
    }

    const list = config.signal();
    const isPresent = this.isSaved(type, item.meta.remote, item.entry.Path);
    let newList: FileBrowserItem[];

    if (isPresent) {
      // Remove matching items. Compare normalized remote names to account for
      // any previously-saved entries that may contain a trailing colon.
      newList = list.filter(
        i =>
          !(
            (i.meta?.remote || '').replace(/:$/, '') ===
              (item.meta?.remote || '').replace(/:$/, '') && i.entry.Path === item.entry.Path
          )
      );
    } else {
      // Add: store a normalized copy to guarantee consistency in persisted data.
      const itemToSave: FileBrowserItem = {
        ...item,
        meta: { ...(item.meta || {}), remote: (item.meta?.remote || '').replace(/:$/, '') },
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
      const rawItems = (await this.appSettingsService.getSettingValue<unknown[]>(fullKey)) ?? [];
      const items: FileBrowserItem[] = rawItems.map((item: unknown) => {
        const rec = item as Record<string, unknown>;
        if (rec && 'remote' in rec && 'entry' in rec) {
          return {
            entry: rec['entry'] as FileBrowserItem['entry'],
            meta: {
              remote: (rec['remote'] as string) || '',
              fsType: 'remote' as const,
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

  private createNautilusOverlay(showAnimation = true): void {
    this.overlayRef = this.overlay.create({
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });

    const portal = new ComponentPortal(NautilusComponent);
    const componentRef: ComponentRef<NautilusComponent> = this.overlayRef.attach(portal);
    this.componentRef = componentRef;

    // Skip entrance animation for deep links / URL parameters
    if (showAnimation) {
      componentRef.location.nativeElement.classList.add('slide-overlay-enter');
    }

    componentRef.instance.closeOverlay.pipe(take(1)).subscribe(() => {
      this.closeFilePicker(null);
    });

    this.overlayRef
      .backdropClick()
      .pipe(take(1))
      .subscribe(() => {
        this.closeFilePicker(null);
      });
  }
}

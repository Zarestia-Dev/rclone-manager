import { ComponentRef, inject, Injectable, signal, WritableSignal, Signal } from '@angular/core';
import { moveItemInArray } from '@angular/cdk/drag-drop';
import { BehaviorSubject, Subject } from 'rxjs';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { take } from 'rxjs/operators';
import { NautilusComponent } from 'src/app/features/components/file-browser/nautilus/nautilus.component';
import { AppSettingsService } from '@app/services';
import { Entry, ExplorerRoot } from '@app/types';

// File picker options shared with UiStateService
export interface FilePickerOptions {
  restrictSingle?: string;
  selectFolders?: boolean;
  selectFiles?: boolean;
  multiSelection?: boolean;
}

export interface StarredItem {
  remote: string;
  entry: Entry;
}

@Injectable({
  providedIn: 'root',
})
export class NautilusService {
  private overlay = inject(Overlay);
  private appSettingsService = inject(AppSettingsService);

  // Nautilus / Browser overlay
  private _isNautilusOverlayOpen = new BehaviorSubject<boolean>(false);
  public isNautilusOverlayOpen$ = this._isNautilusOverlayOpen.asObservable();

  public get isNautilusOverlayOpen(): boolean {
    return this._isNautilusOverlayOpen.getValue();
  }

  // File Picker state
  private _filePickerState = new BehaviorSubject<{
    isOpen: boolean;
    options?: FilePickerOptions;
  }>({ isOpen: false });
  public filePickerState$ = this._filePickerState.asObservable();
  private _filePickerResult = new Subject<string[] | null>();
  public filePickerResult$ = this._filePickerResult.asObservable();

  // Starred Items State - Centralized here
  public starredItems: WritableSignal<StarredItem[]> = signal([]);

  // Bookmarks State (same shape as starred items)
  public bookmarks: WritableSignal<StarredItem[]> = signal([]);

  private overlayRef: OverlayRef | null = null;

  constructor() {
    this.loadStarredItems();
    this.loadBookmarks();
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

  openFilePicker(options: FilePickerOptions): void {
    if (this.overlayRef) return;
    this._filePickerState.next({ isOpen: true, options });
    this._isNautilusOverlayOpen.next(true);
    this.createNautilusOverlay();
  }

  closeFilePicker(result: string[] | null): void {
    this._filePickerResult.next(result);
    this._filePickerState.next({ isOpen: false });
    this._isNautilusOverlayOpen.next(false);
    if (this.overlayRef) {
      this.overlayRef.dispose();
      this.overlayRef = null;
    }
  }

  // --- Starred Items Logic ---

  async loadStarredItems(): Promise<void> {
    try {
      const items =
        (await this.appSettingsService.getSettingValue<StarredItem[]>('nautilus.starred')) ?? [];
      console.log('Loaded starred items from settings:', items);

      if (Array.isArray(items)) {
        // Filter out any malformed items just in case
        const validItems = items.filter(i => i.remote && i.entry?.Path);
        this.starredItems.set(validItems);
      }
    } catch (e) {
      console.warn('Failed to load starred items', e);
    }
  }

  public isStarred(remote: string, path: string): boolean {
    const cleanRemote = remote.replace(/:$/, '');
    return this.starredItems().some(
      i => i.remote.replace(/:$/, '') === cleanRemote && i.entry?.Path === path
    );
  }

  /**
   * Toggles the starred status of an item.
   * @param remoteIdentifier The rclone identifier string (e.g. "gdrive:" or "/home").
   * @param entry The file entry to toggle.
   */
  public toggleStar(remoteIdentifier: string, entry: Entry): void {
    // No need to normalize here if we trust our FileBrowserItem type,
    // but a safety check never hurts:
    const cleanId = remoteIdentifier.trim();

    const currentList = this.starredItems();

    const isPresent = currentList.some(i => i.remote === cleanId && i.entry.Path === entry.Path);

    let newList: StarredItem[];

    if (isPresent) {
      newList = currentList.filter(i => !(i.remote === cleanId && i.entry.Path === entry.Path));
    } else {
      newList = [...currentList, { remote: cleanId, entry }];
    }

    this.starredItems.set(newList);
    this.appSettingsService.saveSetting('nautilus', 'starred', newList);
  }

  // --- Bookmarks Logic (moved from BookmarkService) ---
  getBookmarks(): Signal<StarredItem[]> {
    return this.bookmarks.asReadonly();
  }

  addBookmark(item: Entry, remote: ExplorerRoot | null): void {
    if (!remote) return;

    const remoteIdentifier = remote.fs_type === 'remote' ? `${remote.name}:` : remote.name;

    const newBookmark: StarredItem = {
      remote: remoteIdentifier,
      entry: item,
    };

    const remoteNameForCheck = remote.name.replace(/:$/, '');
    const exists = this.bookmarks().some(
      b => b.remote.replace(/:$/, '') === remoteNameForCheck && b.entry.Path === item.Path
    );

    if (exists) return;

    this.bookmarks.update(list => [...list, newBookmark]);
    this.saveBookmarks();
  }

  removeBookmark(bookmark: StarredItem): void {
    this.bookmarks.update(list =>
      list.filter(b => !(b.remote === bookmark.remote && b.entry.Path === bookmark.entry.Path))
    );
    this.saveBookmarks();
  }

  reorderBookmarks(prevIndex: number, currIndex: number): void {
    this.bookmarks.update(list => {
      const newList = [...list];
      moveItemInArray(newList, prevIndex, currIndex);
      return newList;
    });
    this.saveBookmarks();
  }

  private saveBookmarks(): void {
    this.appSettingsService.saveSetting('nautilus', 'bookmarks', this.bookmarks());
  }

  private async loadBookmarks(): Promise<void> {
    try {
      const bookmarks =
        (await this.appSettingsService.getSettingValue<StarredItem[]>('nautilus.bookmarks')) ?? [];
      if (Array.isArray(bookmarks)) {
        const validItems = bookmarks.filter(i => i.remote && i.entry?.Path);
        this.bookmarks.set(validItems);
      }
    } catch (e) {
      console.warn('Bookmarks load error', e);
    }
  }

  private createNautilusOverlay(): void {
    this.overlayRef = this.overlay.create({
      hasBackdrop: true,
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });

    const portal = new ComponentPortal(NautilusComponent);
    const componentRef: ComponentRef<NautilusComponent> = this.overlayRef.attach(portal);

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

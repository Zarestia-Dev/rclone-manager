import { ComponentRef, inject, Injectable, signal, WritableSignal } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { take } from 'rxjs/operators';
import { NautilusComponent } from 'src/app/features/components/file-browser/nautilus/nautilus.component';
import { AppSettingsService } from '@app/services';
import { Entry } from '@app/types';

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

  private overlayRef: OverlayRef | null = null;

  constructor() {
    this.loadStarredItems();
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
    return this.starredItems().some(i => i.remote === remote && i.entry?.Path === path);
  }

  public toggleStar(remote: string, entry: Entry): void {
    const currentList = this.starredItems();
    const isPresent = this.isStarred(remote, entry.Path);
    let newList: StarredItem[];

    if (isPresent) {
      // Remove
      newList = currentList.filter(i => !(i.remote === remote && i.entry.Path === entry.Path));
    } else {
      // Add
      newList = [...currentList, { remote, entry }];
    }

    this.starredItems.set(newList);
    this.appSettingsService.saveSetting('nautilus', 'starred', newList);
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

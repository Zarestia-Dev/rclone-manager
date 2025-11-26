import { inject, Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { take } from 'rxjs/operators';
import { NautilusComponent } from 'src/app/features/components/file-browser/nautilus/nautilus.component';

// File picker options shared with UiStateService
export interface FilePickerOptions {
  restrictSingle?: string;
  selectFolders?: boolean;
  selectFiles?: boolean;
  multiSelection?: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class NautilusService {
  private overlay = inject(Overlay);
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

  private overlayRef: OverlayRef | null = null;

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

  private createNautilusOverlay(): void {
    this.overlayRef = this.overlay.create({
      hasBackdrop: true,
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });

    const portal = new ComponentPortal(NautilusComponent);
    const componentRef: import('@angular/core').ComponentRef<NautilusComponent> =
      this.overlayRef.attach(portal);

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

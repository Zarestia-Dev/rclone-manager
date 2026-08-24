import { Injectable, Type } from '@angular/core';
import type { MainUiContainerComponent } from 'src/app/layout/main-ui-container.component';
import { BaseSlideOverlayService } from './base-slide-overlay.service';

@Injectable({ providedIn: 'root' })
export class MainUiOverlayService extends BaseSlideOverlayService<MainUiContainerComponent> {
  readonly isMainUiOverlayOpen = this.isOpen;

  protected async loadComponent(): Promise<Type<MainUiContainerComponent>> {
    const { MainUiContainerComponent } = await import('src/app/layout/main-ui-container.component');
    return MainUiContainerComponent;
  }

  protected getStandaloneConfig(): { url: string; label: string; title: string } {
    return {
      url: `${window.location.origin}/?standalone=main`,
      label: 'main-standalone',
      title: 'RClone Manager',
    };
  }

  protected detectStandaloneWindow(): boolean {
    const urlParams = new URLSearchParams(window.location.search);
    const hash = window.location.hash;
    const label = this.getCurrentTauriWindow()?.label;
    return (
      urlParams.get('standalone') === 'main' ||
      (label?.startsWith('main-') ?? false) ||
      hash.startsWith('#/main')
    );
  }

  openMainUiOverlay(): Promise<void> {
    return this.openOverlay();
  }

  closeMainUiOverlay(): void {
    this.closeOverlay();
  }

  toggleMainUiOverlay(): void {
    this.toggleOverlay();
  }
}

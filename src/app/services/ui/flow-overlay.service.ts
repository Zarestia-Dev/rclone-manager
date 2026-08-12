import { Injectable, Type } from '@angular/core';
import type { FlowContainerComponent } from 'src/app/flow/flow-container.component';
import { BaseSlideOverlayService } from './base-slide-overlay.service';

@Injectable({ providedIn: 'root' })
export class FlowOverlayService extends BaseSlideOverlayService<FlowContainerComponent> {
  readonly isFlowOverlayOpen = this.isOpen;

  protected async loadComponent(): Promise<Type<FlowContainerComponent>> {
    const { FlowContainerComponent } = await import('src/app/flow/flow-container.component');
    return FlowContainerComponent;
  }

  protected getStandaloneConfig(): { url: string; label: string; title: string } {
    return {
      url: `${window.location.origin}/flow?standalone=flow`,
      label: 'flow',
      title: 'Flow Workspace',
    };
  }

  protected detectStandaloneWindow(): boolean {
    const urlParams = new URLSearchParams(window.location.search);
    const hash = window.location.hash;
    const label = this.getCurrentTauriWindow()?.label;
    return (
      urlParams.get('standalone') === 'flow' ||
      (label?.startsWith('flow') ?? false) ||
      hash.startsWith('#/flow')
    );
  }

  openFlowOverlay(): Promise<void> {
    return this.openOverlay();
  }

  closeFlowOverlay(): void {
    this.closeOverlay();
  }

  toggleFlowOverlay(): void {
    this.toggleOverlay();
  }
}

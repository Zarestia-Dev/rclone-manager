import { Component, ChangeDetectionStrategy, computed, viewChild } from '@angular/core';
import { TitlebarComponent } from './titlebar/titlebar.component';
import { BannerComponent } from './banners/banner.component';
import { HomeComponent } from '../home/home.component';
import { TabsButtonsComponent } from './tabs-buttons/tabs-buttons.component';

@Component({
  selector: 'app-main-ui-container',
  standalone: true,
  imports: [TitlebarComponent, BannerComponent, HomeComponent, TabsButtonsComponent],
  template: `
    <div class="main-ui-wrapper">
      <app-titlebar data-tauri-drag-region></app-titlebar>
      <app-banner></app-banner>
      <app-home></app-home>
      <app-tabs [mobileHidden]="tabsMobileHidden()" data-tauri-drag-region></app-tabs>
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        width: 100vw;
        height: 100dvh;
        background-color: var(--window-bg-color);
        box-sizing: border-box;
      }
      .main-ui-wrapper {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MainUiContainerComponent {
  private readonly home = viewChild(HomeComponent);
  readonly tabsMobileHidden = computed(() => {
    const home = this.home();
    if (!home) return false;
    return home.isSidebarOver() && home.isSidebarOpen();
  });
}

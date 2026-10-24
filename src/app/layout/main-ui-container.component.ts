import { Component, ChangeDetectionStrategy, computed, viewChild } from '@angular/core';
import { TitlebarComponent } from './titlebar/titlebar.component';
import { BannerComponent } from './banners/banner.component';
import { HomeComponent } from '../home/home.component';
import { TabsButtonsComponent } from './tabs-buttons/tabs-buttons.component';
import { WorkspaceShellComponent } from './workspace-shell/workspace-shell.component';

@Component({
  selector: 'app-main-ui-container',
  standalone: true,
  imports: [
    TitlebarComponent,
    BannerComponent,
    HomeComponent,
    TabsButtonsComponent,
    WorkspaceShellComponent,
  ],
  templateUrl: './main-ui-container.component.html',
  host: { class: 'workspace-container' },
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

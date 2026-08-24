import {
  Component,
  OnInit,
  inject,
  ChangeDetectionStrategy,
  input,
  output,
  computed,
  TemplateRef,
} from '@angular/core';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe } from '@ngx-translate/core';

// Services
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { ConnectionService } from 'src/app/services/infrastructure/system/connection.service';
import { MainUiOverlayService } from 'src/app/services/ui/main-ui-overlay.service';
import { FlowOverlayService } from 'src/app/services/ui/flow-overlay.service';
import { isMobile } from 'src/app/services/infrastructure/platform/api-client.service';
import { WindowControlsComponent } from 'src/app/shared/components/window-controls/window-controls.component';
import { AppMenuComponent } from 'src/app/shared/components/app-menu/app-menu.component';

@Component({
  selector: 'app-titlebar',
  standalone: true,
  imports: [
    CdkMenuModule,
    MatIconModule,
    MatButtonModule,
    TranslatePipe,
    WindowControlsComponent,
    AppMenuComponent,
  ],
  templateUrl: './titlebar.component.html',
  styleUrls: ['./titlebar.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TitlebarComponent implements OnInit {
  private readonly modalService = inject(ModalService);
  readonly mainUiOverlayService = inject(MainUiOverlayService);
  readonly flowOverlayService = inject(FlowOverlayService);
  readonly uiStateService = inject(UiStateService);
  readonly connectionService = inject(ConnectionService);
  readonly isMobile = isMobile;

  readonly overlayType = input<'main' | 'flow' | 'none'>('main');
  readonly customAddMenu = input<TemplateRef<unknown> | null>(null);
  readonly showHome = input<boolean | null>(null);
  readonly homeClick = output<void>();

  readonly isOverlayOpen = computed(() => {
    switch (this.overlayType()) {
      case 'main':
        return this.mainUiOverlayService.isMainUiOverlayOpen();
      case 'flow':
        return this.flowOverlayService.isFlowOverlayOpen();
      default:
        return false;
    }
  });

  readonly isHomeVisible = computed(() => {
    const custom = this.showHome();
    if (custom !== null) return custom;
    return !!this.uiStateService.selectedRemote();
  });

  readonly addRemoteMenuItems = [
    {
      label: 'titlebar.menu.quickRemote',
      shortcut: 'Ctrl + R',
      action: (): void => this.openQuickAddRemoteModal(),
    },
    {
      label: 'titlebar.menu.detailedRemote',
      shortcut: 'Ctrl + N',
      action: (): void => this.openRemoteConfigModal(),
    },
  ];

  async ngOnInit(): Promise<void> {
    try {
      await this.connectionService.runInternetCheck();
    } catch (error) {
      console.error('Initialization error:', error);
    }
  }

  detachOverlay(): void {
    if (this.overlayType() === 'flow') {
      void this.flowOverlayService.detachToStandaloneWindow();
    } else if (this.overlayType() === 'main') {
      void this.mainUiOverlayService.detachToStandaloneWindow();
    }
  }

  closeOverlay(): void {
    if (this.overlayType() === 'flow') {
      this.flowOverlayService.closeFlowOverlay();
    } else if (this.overlayType() === 'main') {
      this.mainUiOverlayService.closeMainUiOverlay();
    }
  }

  onHomeClicked(): void {
    if (this.showHome() !== null) {
      this.homeClick.emit();
    } else {
      this.resetRemote();
    }
  }

  // Modal Methods
  openQuickAddRemoteModal(): void {
    this.modalService.openQuickAddRemote();
  }

  openRemoteConfigModal(): void {
    this.modalService.openRemoteConfig();
  }

  // Reset Remote Selection
  resetRemote(): void {
    this.uiStateService.resetSelectedRemote();
    this.uiStateService.setMainView('main_menu');
  }
}

import { Component, ChangeDetectionStrategy, signal, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import { FlowOverlayService } from 'src/app/services/ui/flow-overlay.service';
import { isMobile } from 'src/app/services/infrastructure/platform/api-client.service';

import { WindowControlsComponent } from 'src/app/shared/components/window-controls/window-controls.component';
import { AppMenuComponent } from 'src/app/shared/components/app-menu/app-menu.component';

export type FlowSubMode = 'builder' | 'quick_run';

@Component({
  selector: 'app-flow-container',
  imports: [
    MatIconModule,
    MatButtonModule,
    TranslatePipe,
    WindowControlsComponent,
    AppMenuComponent,
  ],
  templateUrl: './flow-container.component.html',
  styleUrl: './flow-container.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlowContainerComponent {
  readonly flowOverlayService = inject(FlowOverlayService);
  readonly activeSubMode = signal<FlowSubMode>('builder');
  readonly isMobile = isMobile;

  setSubMode(mode: FlowSubMode): void {
    this.activeSubMode.set(mode);
  }

  detachOverlay(): void {
    void this.flowOverlayService.detachToStandaloneWindow();
  }

  closeOverlay(): void {
    this.flowOverlayService.closeFlowOverlay();
  }
}

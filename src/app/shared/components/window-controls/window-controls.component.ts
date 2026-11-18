import { Component, ChangeDetectionStrategy, computed, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { WindowService } from 'src/app/services/ui/window.service';

@Component({
  selector: 'app-window-controls',
  imports: [MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './window-controls.component.html',
  styleUrls: ['./window-controls.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WindowControlsComponent {
  private readonly windowService = inject(WindowService);
  private readonly uiStateService = inject(UiStateService);

  /** The title bar side these controls sit on; the desktop's button layout decides what goes where. */
  readonly side = input<'start' | 'end'>('end');

  private readonly isMaximized = this.windowService.isMaximized;

  readonly windowButtons = computed(() => {
    return this.uiStateService.platform === 'windows' || this.uiStateService.platform === 'linux';
  });

  readonly controls = computed(() =>
    this.windowService.buttonLayout()[this.side()].map(button => {
      switch (button) {
        case 'minimize':
          return {
            icon: 'minimize',
            label: 'titlebar.minimize',
            action: (): Promise<void> => this.windowService.minimize(),
          };
        case 'maximize':
          return {
            icon: this.isMaximized() ? 'collapse' : 'expand',
            label: 'titlebar.maximize',
            action: (): Promise<void> => this.windowService.maximize(),
          };
        case 'close':
          return {
            icon: 'close',
            label: 'titlebar.close',
            action: (): Promise<void> => this.windowService.close(),
            class: 'close-button',
          };
      }
    })
  );
}

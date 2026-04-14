import { Component, ChangeDetectionStrategy, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { UiStateService, WindowService } from '@app/services';

@Component({
  selector: 'app-window-controls',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, TranslateModule],
  templateUrl: './window-controls.component.html',
  styleUrls: ['./window-controls.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WindowControlsComponent {
  private readonly windowService = inject(WindowService);
  private readonly uiStateService = inject(UiStateService);

  private readonly isMaximized = this.windowService.isMaximized;

  readonly windowButtons = computed(() => {
    return this.uiStateService.platform !== 'macos' && this.uiStateService.platform !== 'web';
  });

  readonly controls = computed(() => [
    {
      icon: 'minimize',
      label: 'titlebar.minimize',
      action: (): Promise<void> => this.windowService.minimize(),
    },
    {
      icon: this.isMaximized() ? 'collapse' : 'expand',
      label: 'titlebar.maximize',
      action: (): Promise<void> => this.windowService.maximize(),
    },
    {
      icon: 'close',
      label: 'titlebar.close',
      action: (): Promise<void> => this.windowService.close(),
      class: 'close-button',
    },
  ]);
}

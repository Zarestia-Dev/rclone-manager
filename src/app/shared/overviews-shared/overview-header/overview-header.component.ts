import { Component, ChangeDetectionStrategy, inject, output, input, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { AppTab } from '@app/types';
import { BackendService, RcloneStatusService } from '@app/services';

@Component({
  selector: 'app-overview-header',
  standalone: true,
  imports: [MatIconModule, MatButtonModule, MatTooltipModule, TranslateModule],
  templateUrl: './overview-header.component.html',
  styleUrl: './overview-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewHeaderComponent {
  private readonly backendService = inject(BackendService);
  private readonly rcloneStatusService = inject(RcloneStatusService);

  mode = input<AppTab>('general');

  /** Emits when backend indicator is clicked */
  readonly openBackendModal = output<void>();

  /** Current active backend name */
  readonly activeBackend = this.backendService.activeBackend;

  /** All backends for status */
  readonly backends = this.backendService.backends;

  title = computed(() => this.TITLE_MAP[this.mode()] || 'overviews.headers.default');

  backendStatusClass = computed(() => {
    const status = this.rcloneStatusService.rcloneStatus();
    return status === 'active' ? 'connected' : 'disconnected';
  });

  private readonly TITLE_MAP: Record<string, string> = {
    mount: 'overviews.headers.mount',
    sync: 'overviews.headers.sync',
    serve: 'overviews.headers.serve',
    general: 'overviews.headers.general',
  };

  onBackendClick(): void {
    this.openBackendModal.emit();
  }
}

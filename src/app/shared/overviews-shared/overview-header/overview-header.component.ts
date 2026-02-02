import { Component, Input, ChangeDetectionStrategy, inject, output } from '@angular/core';
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

  @Input() mode: AppTab = 'general';

  /** Emits when backend indicator is clicked */
  readonly openBackendModal = output<void>();

  /** Current active backend name */
  readonly activeBackend = this.backendService.activeBackend;

  /** All backends for status */
  readonly backends = this.backendService.backends;

  private readonly TITLE_MAP: Record<string, string> = {
    mount: 'overviews.headers.mount',
    sync: 'overviews.headers.sync',
    serve: 'overviews.headers.serve',
    general: 'overviews.headers.general',
  };

  get title(): string {
    return this.TITLE_MAP[this.mode] || 'overviews.headers.default';
  }

  /** Get status class for the active backend */
  get backendStatusClass(): string {
    const status = this.rcloneStatusService.rcloneStatus();
    if (status === 'active') return 'connected';
    return 'disconnected';
  }

  onBackendClick(): void {
    this.openBackendModal.emit();
  }
}

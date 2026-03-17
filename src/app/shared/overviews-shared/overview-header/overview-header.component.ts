import { Component, ChangeDetectionStrategy, inject, output, input, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { AppTab } from '@app/types';
import { BackendService, RcloneStatusService } from '@app/services';

const TITLE_MAP: Record<AppTab, string> = {
  mount: 'overviews.headers.mount',
  sync: 'overviews.headers.sync',
  serve: 'overviews.headers.serve',
  general: 'overviews.headers.general',
};

@Component({
  selector: 'app-overview-header',
  imports: [MatIconModule, MatTooltipModule, TranslateModule],
  templateUrl: './overview-header.component.html',
  styleUrl: './overview-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewHeaderComponent {
  private readonly backendService = inject(BackendService);
  private readonly rcloneStatusService = inject(RcloneStatusService);

  readonly mode = input<AppTab>('general');

  readonly openBackendModal = output<void>();

  readonly activeBackend = this.backendService.activeBackend;

  readonly title = computed(() => TITLE_MAP[this.mode()] ?? 'overviews.headers.default');

  readonly backendStatusClass = computed(() =>
    this.rcloneStatusService.rcloneStatus() === 'active' ? 'connected' : 'disconnected'
  );
}

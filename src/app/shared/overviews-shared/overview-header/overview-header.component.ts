import { Component, ChangeDetectionStrategy, inject, output, input, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import { AppTab, TITLE_MAP } from '@app/types';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';

@Component({
  selector: 'app-overview-header',
  imports: [MatIconModule, MatButtonModule, TranslatePipe],
  templateUrl: './overview-header.component.html',
  styleUrl: './overview-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewHeaderComponent {
  private readonly backendService = inject(BackendService);
  private readonly rcloneStatusService = inject(RcloneStatusService);
  private readonly uiStateService = inject(UiStateService);

  readonly mode = input<AppTab | string>('general');
  readonly customTitle = input<string | null>(null);
  readonly customIcon = input<string | null>(null);
  readonly showEditButton = input<boolean>(true);

  readonly openBackendModal = output<void>();
  readonly toggleEditLayout = output<void>();

  readonly activeBackend = this.backendService.activeBackend;
  readonly isEditingLayout = this.uiStateService.isEditingLayout;

  readonly title = computed(
    () => this.customTitle() ?? TITLE_MAP[this.mode() as AppTab] ?? 'overviews.headers.default'
  );

  readonly iconName = computed(() => this.customIcon() ?? this.mode());

  readonly backendStatusClass = computed(() =>
    this.rcloneStatusService.rcloneStatus() === 'active' ? 'connected' : 'disconnected'
  );

  onToggleEdit(): void {
    this.toggleEditLayout.emit();
  }
}

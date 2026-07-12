import {
  Component,
  computed,
  input,
  output,
  inject,
  signal,
  linkedSignal,
  ChangeDetectionStrategy,
} from '@angular/core';
import {
  CardDisplayMode,
  OperationTab,
  PrimaryActionType,
  Remote,
  MODE_CONFIG,
  StopJobEvent,
  OpenInFilesEvent,
} from '@app/types';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe } from '@ngx-translate/core';
import { OverviewHeaderComponent } from '../../../../shared/overviews-shared/overview-header/overview-header.component';
import { StatusOverviewPanelComponent } from '../../../../shared/overviews-shared/status-overview-panel/status-overview-panel.component';
import { RemotesPanelComponent } from '../../../../shared/overviews-shared/remotes-panel/remotes-panel.component';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';

@Component({
  selector: 'app-app-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    TranslatePipe,
    OverviewHeaderComponent,
    StatusOverviewPanelComponent,
    RemotesPanelComponent,
  ],
  templateUrl: './app-overview.component.html',
  styleUrl: './app-overview.component.scss',
  host: {
    class: 'app-overview',
    '[class]': 'mode()',
    'attr.animate.enter': 'fade-in-out-enter',
    'attr.animate.leave': 'fade-in-out-leave',
    '(document:click)': 'closeBlossom()',
  },
})
export class AppOverviewComponent {
  private readonly appSettingsService = inject(AppSettingsService);
  readonly remoteFacade = inject(RemoteFacadeService);
  readonly backendService = inject(BackendService);

  // --- Inputs ---
  readonly mode = input<OperationTab>('mount');

  // --- Outputs ---
  readonly remoteSelected = output<Remote>();
  readonly openInFiles = output<OpenInFilesEvent>();
  readonly startJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName: string;
  }>();
  readonly stopJob = output<StopJobEvent>();
  readonly openBackendModal = output<void>();

  // Card display mode is local UI state initialized from settings options signal
  readonly cardDisplayMode = linkedSignal<CardDisplayMode>(() => {
    const saved = this.appSettingsService.options()?.['runtime.dashboard_card_variant']
      ?.value as CardDisplayMode;
    return saved || 'detailed';
  });
  readonly isEditingLayout = signal(false);
  readonly isBlossomOpen = signal(false);

  toggleBlossom(event: MouseEvent): void {
    event.stopPropagation();
    this.isBlossomOpen.update(v => !v);
  }

  closeBlossom(): void {
    this.isBlossomOpen.set(false);
  }

  // --- Derived state ---
  private readonly modeConfig = computed(() => MODE_CONFIG[this.mode()] ?? MODE_CONFIG.mount);

  readonly activeRemotes = computed(() =>
    this.remoteFacade.orderedVisibleRemotes().filter(r => this.isActive(r))
  );
  readonly inactiveRemotes = computed(() =>
    this.remoteFacade.orderedVisibleRemotes().filter(r => !this.isActive(r))
  );

  readonly activeCount = computed(() => this.activeRemotes().length);
  readonly inactiveCount = computed(() => this.inactiveRemotes().length);

  readonly primaryActionLabel = computed(() => this.modeConfig().label);
  readonly activeIcon = computed(() => this.modeConfig().icon);
  readonly activeTitle = computed(() => this.modeConfig().activeTitle);
  readonly inactiveTitle = computed(() => this.modeConfig().inactiveTitle);

  // --- Event handlers ---

  selectRemote(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  triggerOpenInFiles(event: OpenInFilesEvent): void {
    if (event?.remoteName) this.openInFiles.emit(event);
  }

  toggleEditLayout(): void {
    this.isEditingLayout.update(v => !v);
    this.closeBlossom();
  }

  onLayoutChanged(newNames: string[]): void {
    void this.remoteFacade.saveCurrentLayout(this.backendService.activeBackend(), newNames);
  }

  onToggleHidden(remoteName: string): void {
    void this.remoteFacade.toggleRemoteVisibility(this.backendService.activeBackend(), remoteName);
  }

  onCardDisplayModeToggle(): void {
    const nextMode = this.cardDisplayMode() === 'compact' ? 'detailed' : 'compact';
    this.cardDisplayMode.set(nextMode);
    void this.appSettingsService.saveSetting('runtime', 'dashboard_card_variant', nextMode);
    this.closeBlossom();
  }

  // --- Private helpers ---

  private isActive(remote: Remote): boolean {
    switch (this.mode()) {
      case 'mount':
        return remote.status.mount.active;
      case 'operations':
        return (
          remote.status.sync.active ||
          remote.status.copy.active ||
          remote.status.move.active ||
          remote.status.bisync.active
        );
      case 'serve':
        return remote.status.serve.active;
    }
  }
}

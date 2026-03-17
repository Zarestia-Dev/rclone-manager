import { NgClass } from '@angular/common';
import { Component, computed, input, output, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { AppTab, PrimaryActionType, Remote, RemoteActionProgress, ServeListItem } from '@app/types';
import { OverviewHeaderComponent } from '../../../../shared/overviews-shared/overview-header/overview-header.component';
import { StatusOverviewPanelComponent } from '../../../../shared/overviews-shared/status-overview-panel/status-overview-panel.component';
import { RemotesPanelComponent } from '../../../../shared/overviews-shared/remotes-panel/remotes-panel.component';
import { ServeCardComponent } from '../../../../shared/components/serve-card/serve-card.component';
import { getRemoteNameFromFs } from '@app/services';

interface StopJobEvent {
  type: PrimaryActionType;
  remoteName: string;
  serveId?: string;
  profileName?: string;
}

interface ModeConfig {
  label: string;
  icon: string;
  activeTitle: string;
  inactiveTitle: string;
}

const MODE_CONFIG: Record<AppTab, ModeConfig> = {
  mount: {
    label: 'appOverview.labels.mount',
    icon: 'mount',
    activeTitle: 'appOverview.panelTitles.mountedRemotes',
    inactiveTitle: 'appOverview.panelTitles.unmountedRemotes',
  },
  sync: {
    label: 'appOverview.labels.startSync',
    icon: 'sync',
    activeTitle: 'appOverview.panelTitles.activeSync',
    inactiveTitle: 'appOverview.panelTitles.inactiveRemotes',
  },
  serve: {
    label: 'appOverview.labels.startServe',
    icon: 'satellite-dish',
    activeTitle: 'appOverview.panelTitles.activeServes',
    inactiveTitle: 'appOverview.panelTitles.availableRemotes',
  },
  general: {
    label: 'appOverview.labels.start',
    icon: 'circle-check',
    activeTitle: 'appOverview.panelTitles.activeRemotes',
    inactiveTitle: 'appOverview.panelTitles.inactiveRemotes',
  },
};

const FALLBACK_CONFIG: ModeConfig = MODE_CONFIG.general;

@Component({
  selector: 'app-app-overview',
  imports: [
    NgClass,
    MatCardModule,
    MatIconModule,
    OverviewHeaderComponent,
    StatusOverviewPanelComponent,
    RemotesPanelComponent,
    ServeCardComponent,
  ],
  templateUrl: './app-overview.component.html',
  styleUrl: './app-overview.component.scss',
})
export class AppOverviewComponent {
  private readonly translate = inject(TranslateService);

  // Inputs
  readonly mode = input<AppTab>('mount');
  readonly remotes = input<Remote[]>([]);
  readonly selectedRemote = input<Remote | null>(null);
  readonly actionInProgress = input<RemoteActionProgress>({});
  readonly runningServes = input<ServeListItem[]>([]);

  // Outputs
  readonly remoteSelected = output<Remote>();
  readonly openInFiles = output<string>();
  readonly startJob = output<{ type: PrimaryActionType; remoteName: string }>();
  readonly stopJob = output<StopJobEvent>();
  readonly openBackendModal = output<void>();

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------
  private readonly modeConfig = computed(() => MODE_CONFIG[this.mode()] ?? FALLBACK_CONFIG);

  readonly activeRemotes = computed(() => this.remotes().filter(r => this.isRemoteActive(r)));
  readonly inactiveRemotes = computed(() => this.remotes().filter(r => !this.isRemoteActive(r)));
  readonly activeCount = computed(() => this.activeRemotes().length);
  readonly inactiveCount = computed(() => this.inactiveRemotes().length);

  readonly primaryActionLabel = computed(() => this.translate.instant(this.modeConfig().label));
  readonly activeIcon = computed(() => this.modeConfig().icon);
  readonly activeTitle = computed(() => this.translate.instant(this.modeConfig().activeTitle));
  readonly inactiveTitle = computed(() => this.translate.instant(this.modeConfig().inactiveTitle));

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------
  private isRemoteActive(remote: Remote): boolean {
    switch (this.mode()) {
      case 'mount':
        return remote.status.mount.active;
      case 'sync':
        return (
          remote.status.sync.active ||
          remote.status.copy.active ||
          remote.status.move.active ||
          remote.status.bisync.active
        );
      case 'serve':
        return remote.status.serve.active;
      default:
        return false;
    }
  }

  private getServeRemoteName(serve: ServeListItem): string {
    return getRemoteNameFromFs(serve.params?.fs);
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------
  selectRemote(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  triggerOpenInFiles(remoteName: string): void {
    if (remoteName) {
      this.openInFiles.emit(remoteName);
    }
  }

  handleCopyToClipboard(data: { text: string; message: string }): Promise<void> {
    return navigator.clipboard.writeText(data.text).catch(error => {
      console.error('Error copying to clipboard:', error);
    });
  }

  handleServeCardClick(serve: ServeListItem): void {
    const remoteName = this.getServeRemoteName(serve);
    if (!remoteName) return;
    const remote = this.remotes().find(r => r.name === remoteName);
    if (remote) this.selectRemote(remote);
  }

  buildServeStopEvent(serve: ServeListItem): StopJobEvent {
    return {
      type: 'serve',
      serveId: serve.id,
      remoteName: this.getServeRemoteName(serve),
    };
  }
}

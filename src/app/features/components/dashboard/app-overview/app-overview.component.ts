import { CommonModule } from '@angular/common';
import { Component, computed, input, output, inject } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AppTab, PrimaryActionType, Remote, RemoteActionProgress, ServeListItem } from '@app/types';
import { OverviewHeaderComponent } from '../../../../shared/overviews-shared/overview-header/overview-header.component';
import { StatusOverviewPanelComponent } from '../../../../shared/overviews-shared/status-overview-panel/status-overview-panel.component';
import { RemotesPanelComponent } from '../../../../shared/overviews-shared/remotes-panel/remotes-panel.component';
import { ServeCardComponent } from '../../../../shared/components/serve-card/serve-card.component';

// Services
import { IconService } from '@app/services';

@Component({
  selector: 'app-app-overview',
  imports: [
    MatCardModule,
    MatDividerModule,
    CommonModule,
    MatIconModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatButtonModule,
    OverviewHeaderComponent,
    StatusOverviewPanelComponent,
    RemotesPanelComponent,
    ServeCardComponent,
    TranslateModule,
  ],
  templateUrl: './app-overview.component.html',
  styleUrl: './app-overview.component.scss',
})
export class AppOverviewComponent {
  readonly iconService = inject(IconService);
  private translate = inject(TranslateService);

  mode = input<AppTab>('mount');
  remotes = input<Remote[]>([]);
  selectedRemote = input<Remote | null>(null);
  actionInProgress = input<RemoteActionProgress>({});
  runningServes = input<ServeListItem[]>([]);

  remoteSelected = output<Remote>();
  openInFiles = output<string>();
  startJob = output<{ type: PrimaryActionType; remoteName: string }>();
  stopJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    serveId?: string;
    profileName?: string;
  }>();
  openBackendModal = output<void>();

  private isRemoteActive = (remote: Remote): boolean => {
    const mode = this.mode();
    if (mode === 'mount') {
      return remote.mountState?.mounted === true;
    } else if (mode === 'sync') {
      return (
        remote.syncState?.isOnSync === true ||
        remote.copyState?.isOnCopy === true ||
        remote.moveState?.isOnMove === true ||
        remote.bisyncState?.isOnBisync === true
      );
    } else if (mode === 'serve') {
      return remote.serveState?.isOnServe === true;
    }
    return false;
  };

  activeRemotes = computed(() => this.remotes().filter(remote => this.isRemoteActive(remote)));
  inactiveRemotes = computed(() => this.remotes().filter(remote => !this.isRemoteActive(remote)));
  activeCount = computed(() => this.activeRemotes().length);
  inactiveCount = computed(() => this.inactiveRemotes().length);

  title = computed(() => {
    const mode = this.mode();
    if (mode === 'mount') {
      return this.translate.instant('appOverview.titles.mount');
    } else if (mode === 'sync') {
      return this.translate.instant('appOverview.titles.sync');
    } else if (mode === 'serve') {
      return this.translate.instant('appOverview.titles.serve');
    }
    return this.translate.instant('appOverview.titles.remotes');
  });

  // Mode configuration map for labels and icons
  private readonly MODE_CONFIG: Record<
    AppTab,
    { label: string; icon: string; activeTitle: string; inactiveTitle: string }
  > = {
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

  primaryActionLabel = computed(() =>
    this.translate.instant(this.MODE_CONFIG[this.mode()]?.label || 'appOverview.labels.start')
  );
  activeIcon = computed(() => this.MODE_CONFIG[this.mode()]?.icon || 'circle-check');
  primaryActionIcon = computed(() => (this.mode() === 'mount' ? 'mount' : 'play'));
  getActiveTitle = computed(() =>
    this.translate.instant(
      this.MODE_CONFIG[this.mode()]?.activeTitle || 'appOverview.panelTitles.activeRemotes'
    )
  );
  getInactiveTitle = computed(() =>
    this.translate.instant(
      this.MODE_CONFIG[this.mode()]?.inactiveTitle || 'appOverview.panelTitles.inactiveRemotes'
    )
  );

  selectRemote(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  triggerOpenInFiles(remoteName: string): void {
    if (remoteName) {
      this.openInFiles.emit(remoteName);
    }
  }

  async handleCopyToClipboard(data: { text: string; message: string }): Promise<void> {
    try {
      await navigator.clipboard.writeText(data.text);
    } catch (error) {
      console.error('Error copying to clipboard:', error);
    }
  }

  handleServeCardClick(serve: ServeListItem): void {
    const remoteName = serve.params.fs.split(':')[0];
    const remote = this.remotes().find(r => r.remoteSpecs.name === remoteName);
    if (remote) {
      this.selectRemote(remote);
    }
  }
}

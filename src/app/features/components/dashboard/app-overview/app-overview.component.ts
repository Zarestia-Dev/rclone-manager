import { CommonModule } from '@angular/common';
import { Component, computed, input, output, inject } from '@angular/core';
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
  ],
  templateUrl: './app-overview.component.html',
  styleUrl: './app-overview.component.scss',
})
export class AppOverviewComponent {
  readonly iconService = inject(IconService);

  mode = input<AppTab>('mount');
  remotes = input<Remote[]>([]);
  selectedRemote = input<Remote | null>(null);
  actionInProgress = input<RemoteActionProgress>({});
  runningServes = input<ServeListItem[]>([]);

  remoteSelected = output<Remote>();
  openInFiles = output<string>();
  startJob = output<{ type: PrimaryActionType; remoteName: string }>();
  stopJob = output<{ type: PrimaryActionType; remoteName: string; serveId?: string }>();
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
      return 'Mount Overview';
    } else if (mode === 'sync') {
      return 'Sync Operations Overview';
    } else if (mode === 'serve') {
      return 'Serve Overview';
    }
    return 'Remotes Overview';
  });

  // Mode configuration map for labels and icons
  private readonly MODE_CONFIG: Record<
    AppTab,
    { label: string; icon: string; activeTitle: string; inactiveTitle: string }
  > = {
    mount: {
      label: 'Mount',
      icon: 'mount',
      activeTitle: 'Mounted Remotes',
      inactiveTitle: 'Unmounted Remotes',
    },
    sync: {
      label: 'Start Sync',
      icon: 'sync',
      activeTitle: 'Active Sync Operations',
      inactiveTitle: 'Inactive Remotes',
    },
    serve: {
      label: 'Start Serve',
      icon: 'satellite-dish',
      activeTitle: 'Active Serves',
      inactiveTitle: 'Available Remotes',
    },
    general: {
      label: 'Start',
      icon: 'circle-check',
      activeTitle: 'Active Remotes',
      inactiveTitle: 'Inactive Remotes',
    },
  };

  primaryActionLabel = computed(() => this.MODE_CONFIG[this.mode()]?.label || 'Start');
  activeIcon = computed(() => this.MODE_CONFIG[this.mode()]?.icon || 'circle-check');
  primaryActionIcon = computed(() => (this.mode() === 'mount' ? 'mount' : 'play'));
  getActiveTitle = computed(() => this.MODE_CONFIG[this.mode()]?.activeTitle || 'Active Remotes');
  getInactiveTitle = computed(
    () => this.MODE_CONFIG[this.mode()]?.inactiveTitle || 'Inactive Remotes'
  );

  selectRemote(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  triggerOpenInFiles(remoteName: string): void {
    if (remoteName) {
      this.openInFiles.emit(remoteName);
    }
  }

  handleCopyToClipboard(data: { text: string; message: string }): void {
    try {
      navigator.clipboard.writeText(data.text);
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

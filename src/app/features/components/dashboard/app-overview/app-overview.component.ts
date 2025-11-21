import { CommonModule } from '@angular/common';
import { Component, computed, input, output, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AppTab, PrimaryActionType, Remote, RemoteActionProgress } from '@app/types';
import { OverviewHeaderComponent } from '../../../../shared/overviews-shared/overview-header/overview-header.component';
import { StatusOverviewPanelComponent } from '../../../../shared/overviews-shared/status-overview-panel/status-overview-panel.component';
import { RemotesPanelComponent } from '../../../../shared/overviews-shared/remotes-panel/remotes-panel.component';

// Services
import { IconService } from '../../../../shared/services/icon.service';
import { AnimationsService } from '../../../../shared/services/animations.service';

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
  ],
  animations: [AnimationsService.fadeInOut()],
  templateUrl: './app-overview.component.html',
  styleUrl: './app-overview.component.scss',
})
export class AppOverviewComponent {
  readonly iconService = inject(IconService);

  mode = input<AppTab>('mount');
  remotes = input<Remote[]>([]);
  selectedRemote = input<Remote | null>(null);
  actionInProgress = input<RemoteActionProgress>({});

  remoteSelected = output<Remote>();
  openInFiles = output<string>();
  startJob = output<{ type: PrimaryActionType; remoteName: string }>();
  stopJob = output<{ type: PrimaryActionType; remoteName: string }>();

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
    }
    return 'Remotes Overview';
  });

  primaryActionLabel = computed(() => {
    switch (this.mode()) {
      case 'mount':
        return 'Mount';
      case 'sync':
        return 'Start Sync';
      default:
        return 'Start';
    }
  });

  activeIcon = computed(() => {
    switch (this.mode()) {
      case 'mount':
        return 'mount';
      case 'sync':
        return 'sync';
      default:
        return 'circle-check';
    }
  });

  primaryActionIcon = computed(() => (this.mode() === 'mount' ? 'mount' : 'play'));

  getActiveTitle = computed(() => {
    switch (this.mode()) {
      case 'mount':
        return 'Mounted Remotes';
      case 'sync':
        return 'Active Sync Operations';
      default:
        return 'Active Remotes';
    }
  });

  getInactiveTitle = computed(() => {
    switch (this.mode()) {
      case 'mount':
        return 'Unmounted Remotes';
      case 'sync':
        return 'Inactive Remotes';
      default:
        return 'Inactive Remotes';
    }
  });

  selectRemote(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  triggerOpenInFiles(remoteName: string): void {
    if (remoteName) {
      this.openInFiles.emit(remoteName);
    }
  }
}

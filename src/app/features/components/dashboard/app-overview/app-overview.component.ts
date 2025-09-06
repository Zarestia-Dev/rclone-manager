import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';
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
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppOverviewComponent {
  @Input() mode: AppTab = 'mount'; // Default to 'mount' mode
  @Input() remotes: Remote[] = [];
  @Input() selectedRemote: Remote | null = null;
  @Input() iconService!: IconService;
  @Input() actionInProgress: RemoteActionProgress = {};

  @Output() remoteSelected = new EventEmitter<Remote>();
  @Output() openInFiles = new EventEmitter<string>();
  @Output() startJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();
  @Output() stopJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();

  // Computed properties based on mode
  get activeRemotes(): Remote[] {
    return this.remotes.filter(remote => {
      if (this.mode === 'mount') {
        return remote.mountState?.mounted === true;
      } else if (this.mode === 'sync') {
        return (
          remote.syncState?.isOnSync === true ||
          remote.copyState?.isOnCopy === true ||
          remote.moveState?.isOnMove === true ||
          remote.bisyncState?.isOnBisync === true
        );
      }
      return false;
    });
  }

  get inactiveRemotes(): Remote[] {
    return this.remotes.filter(remote => {
      if (this.mode === 'mount') {
        return !remote.mountState?.mounted;
      } else if (this.mode === 'sync') {
        return (
          !remote.syncState?.isOnSync &&
          !remote.copyState?.isOnCopy &&
          !remote.moveState?.isOnMove &&
          !remote.bisyncState?.isOnBisync
        );
      }
      return false;
    });
  }

  get errorRemotes(): Remote[] {
    return this.remotes.filter(remote => {
      if (this.mode === 'mount') {
        return remote.mountState?.mounted === 'error';
      } else if (this.mode === 'sync') {
        return (
          remote.syncState?.isOnSync === 'error' ||
          remote.copyState?.isOnCopy === 'error' ||
          remote.moveState?.isOnMove === 'error' ||
          remote.bisyncState?.isOnBisync === 'error'
        );
      }
      return false;
    });
  }

  get activeCount(): number {
    return this.activeRemotes.length;
  }

  get inactiveCount(): number {
    return this.inactiveRemotes.length;
  }

  get errorCount(): number {
    return this.errorRemotes.length;
  }

  get title(): string {
    if (this.mode === 'mount') {
      return 'Mount Overview';
    } else if (this.mode === 'sync') {
      return 'Sync Operations Overview';
    }
    return 'Remotes Overview';
  }

  get primaryActionLabel(): string {
    switch (this.mode) {
      case 'mount':
        return 'Mount';
      case 'sync':
        return 'Start Sync';
      default:
        return 'Start';
    }
  }

  get activeIcon(): string {
    switch (this.mode) {
      case 'mount':
        return 'mount';
      case 'sync':
        return 'sync';
      default:
        return 'circle-check';
    }
  }

  get primaryActionIcon(): string {
    return this.mode === 'mount' ? 'mount' : 'play';
  }

  getActiveTitle(): string {
    switch (this.mode) {
      case 'mount':
        return 'Mounted Remotes';
      case 'sync':
        return 'Active Sync Operations';
      // case 'files':
      //   return 'Copying Remotes';
      default:
        return 'Active Remotes';
    }
  }

  getInactiveTitle(): string {
    switch (this.mode) {
      case 'mount':
        return 'Unmounted Remotes';
      case 'sync':
        return 'Inactive Remotes';
      default:
        return 'Inactive Remotes';
    }
  }

  getErrorTitle(): string {
    switch (this.mode) {
      case 'mount':
        return 'Remotes with Mount Errors';
      case 'sync':
        return 'Remotes with Sync Errors';
      default:
        return 'Remotes with Problems';
    }
  }

  selectRemote(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  triggerOpenInFiles(remoteName: string): void {
    if (remoteName) {
      this.openInFiles.emit(remoteName);
    }
  }
}

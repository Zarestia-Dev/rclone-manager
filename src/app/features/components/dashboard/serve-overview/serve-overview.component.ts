import { CommonModule } from '@angular/common';
import { Component, inject, input, output, computed } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { Remote, RemoteActionProgress, ServeListItem } from '@app/types';
import { OverviewHeaderComponent } from '../../../../shared/overviews-shared/overview-header/overview-header.component';
import { StatusOverviewPanelComponent } from '../../../../shared/overviews-shared/status-overview-panel/status-overview-panel.component';
import { RemotesPanelComponent } from '../../../../shared/overviews-shared/remotes-panel/remotes-panel.component';

// Services
import { IconService } from '../../../../shared/services/icon.service';
import { AnimationsService } from '../../../../shared/services/animations.service';
import { ServeCardComponent } from '../../../../shared/components/serve-card/serve-card.component';

@Component({
  selector: 'app-serve-overview',
  standalone: true,
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
    // Serve cards for active serve instances
    ServeCardComponent,
    MatSnackBarModule,
  ],
  animations: [AnimationsService.fadeInOut()],
  templateUrl: './serve-overview.component.html',
  styleUrl: './serve-overview.component.scss',
})
export class ServeOverviewComponent {
  readonly iconService = inject(IconService);

  remotes = input.required<Remote[]>();
  actionInProgress = input<RemoteActionProgress>({});
  runningServes = input.required<ServeListItem[]>();

  remoteSelected = output<Remote>();
  startJob = output<{ type: 'serve'; remoteName: string }>();
  stopJob = output<{ type: 'serve'; remoteName: string; serveId: string }>();

  private isRemoteActive(remote: Remote): boolean {
    return remote.serveState?.hasActiveServes === true;
  }

  readonly activeRemotes = computed(() =>
    this.remotes().filter(remote => this.isRemoteActive(remote))
  );
  readonly inactiveRemotes = computed(() =>
    this.remotes().filter(remote => !this.isRemoteActive(remote))
  );
  readonly activeCount = computed(() => this.activeRemotes().length);
  readonly inactiveCount = computed(() => this.inactiveRemotes().length);

  readonly title = 'Serve Overview';

  readonly primaryActionLabel = 'Start Serve';

  readonly activeIcon = 'satellite-dish';

  readonly primaryActionIcon = 'play';

  getActiveTitle(): string {
    return `Active Serves`;
  }

  getInactiveTitle(): string {
    return `Available Remotes`;
  }

  selectRemote(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  triggerStartServe(remoteName: string): void {
    this.startJob.emit({ type: 'serve', remoteName });
  }

  /**
   * Handle stop event from a child serve card
   */
  onStopServe(serve: ServeListItem): void {
    const remoteName = serve.params.fs.split(':')[0];
    this.stopJob.emit({ type: 'serve', remoteName, serveId: serve.id });
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

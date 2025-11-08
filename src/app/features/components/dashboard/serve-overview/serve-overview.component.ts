import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  ChangeDetectionStrategy,
  inject,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Remote, RemoteActionProgress, ServeListItem } from '@app/types';
import { OverviewHeaderComponent } from '../../../../shared/overviews-shared/overview-header/overview-header.component';
import { StatusOverviewPanelComponent } from '../../../../shared/overviews-shared/status-overview-panel/status-overview-panel.component';
import { RemotesPanelComponent } from '../../../../shared/overviews-shared/remotes-panel/remotes-panel.component';

// Services
import { IconService } from '../../../../shared/services/icon.service';
import { AnimationsService } from '../../../../shared/services/animations.service';
import { ServeManagementService } from '@app/services';
import { Subject, takeUntil } from 'rxjs';

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
  ],
  animations: [AnimationsService.fadeInOut()],
  templateUrl: './serve-overview.component.html',
  styleUrl: './serve-overview.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServeOverviewComponent implements OnInit, OnDestroy {
  readonly iconService = inject(IconService);
  private readonly serveManagementService = inject(ServeManagementService);
  private destroy$ = new Subject<void>();

  @Input() remotes: Remote[] = [];
  @Input() actionInProgress: RemoteActionProgress = {};

  @Output() remoteSelected = new EventEmitter<Remote>();
  @Output() startServe = new EventEmitter<string>();

  runningServes: ServeListItem[] = [];

  ngOnInit(): void {
    // Subscribe to running serves
    this.serveManagementService.runningServes$.pipe(takeUntil(this.destroy$)).subscribe(serves => {
      this.runningServes = serves;
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private isRemoteActive(remote: Remote): boolean {
    return remote.serveState?.hasActiveServes === true;
  }

  get activeRemotes(): Remote[] {
    return this.remotes.filter(remote => this.isRemoteActive(remote));
  }

  get inactiveRemotes(): Remote[] {
    return this.remotes.filter(remote => !this.isRemoteActive(remote));
  }

  get activeCount(): number {
    return this.activeRemotes.length;
  }

  get inactiveCount(): number {
    return this.inactiveRemotes.length;
  }

  readonly title = 'Serve Overview';

  readonly primaryActionLabel = 'Start Serve';

  readonly activeIcon = 'satellite-dish';

  readonly primaryActionIcon = 'play';

  getActiveTitle(): string {
    return `Active Serves (${this.activeCount})`;
  }

  getInactiveTitle(): string {
    return `Available Remotes (${this.inactiveCount})`;
  }

  selectRemote(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  triggerStartServe(remoteName: string): void {
    this.startServe.emit(remoteName);
  }
}

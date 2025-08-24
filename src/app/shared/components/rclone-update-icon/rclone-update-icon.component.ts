import { Component, OnInit, OnDestroy, inject } from '@angular/core';

import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { Subject, takeUntil } from 'rxjs';
import { UpdateConfirmationDialogComponent } from '../../modals/update-confirmation-dialog/update-confirmation-dialog.component';

// Services
import { RcloneUpdateService, UpdateStatus } from '@app/services';

@Component({
  selector: 'app-rclone-update-icon',
  standalone: true,
  imports: [
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatDialogModule,
  ],
  templateUrl: './rclone-update-icon.component.html',
  styleUrl: './rclone-update-icon.component.scss',
})
export class RcloneUpdateIconComponent implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  private updateService = inject(RcloneUpdateService);
  private dialog = inject(MatDialog);

  updateStatus: UpdateStatus = {
    checking: false,
    updating: false,
    available: false,
    error: null,
    lastCheck: null,
    updateInfo: null,
  };

  ngOnInit(): void {
    // Subscribe to update status changes
    this.updateService.updateStatus$
      .pipe(takeUntil(this.destroy$))
      .subscribe((status: UpdateStatus) => {
        this.updateStatus = status;
      });

    // Initial check for updates
    this.checkForUpdates();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async checkForUpdates(): Promise<void> {
    await this.updateService.checkForUpdates();
  }

  getIcon(): string {
    if (this.updateStatus.available) return 'circle-up';
    if (this.updateStatus.error) return 'warning';
    return 'gear';
  }

  getIconColor(): string {
    if (this.updateStatus.available) return 'primary';
    if (this.updateStatus.error) return 'warn';
    return '';
  }

  getTooltipText(): string {
    if (this.updateStatus.checking) return 'Checking for updates...';
    if (this.updateStatus.updating) return 'Updating rclone...';
    if (this.updateStatus.available) return 'Rclone update available';
    if (this.updateStatus.error) return 'Update check failed';
    return 'Check for rclone updates';
  }

  formatLastCheck(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  async showUpdateDialog(): Promise<void> {
    if (!this.updateStatus.updateInfo) {
      return;
    }

    const info = this.updateStatus.updateInfo;
    if (!info) return;

    const dialogRef = this.dialog.open(UpdateConfirmationDialogComponent, {
      data: info,
      disableClose: true,
      autoFocus: true,
      minWidth: '360px',
      height: '80vh',
      maxHeight: '630px',
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (result) {
      await this.updateService.performUpdate();
    }
  }
}

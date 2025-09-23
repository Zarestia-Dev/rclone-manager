import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { Subject, takeUntil, firstValueFrom } from 'rxjs';
import { UpdateConfirmationDialogComponent } from '../../modals/update-confirmation-dialog/update-confirmation-dialog.component';
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
    this.updateService.updateStatus$
      .pipe(takeUntil(this.destroy$))
      .subscribe((status: UpdateStatus) => {
        this.updateStatus = status;
      });

    this.checkForUpdates();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async checkForUpdates(): Promise<void> {
    await this.updateService.checkForUpdates();
  }

  // New consolidated methods for the improved template
  getStatusClass(): string {
    if (this.updateStatus.checking) return 'checking';
    if (this.updateStatus.updating) return 'updating';
    if (this.updateStatus.available) return 'available';
    if (this.updateStatus.error) return 'error';
    return 'up-to-date';
  }

  getSpinnerTooltip(): string {
    return this.updateStatus.checking ? 'Checking for updates...' : 'Updating rclone...';
  }

  getButtonTooltip(): string {
    if (this.updateStatus.available && this.updateStatus.updateInfo) {
      return `Update available: ${this.updateStatus.updateInfo.current_version_clean} → ${this.updateStatus.updateInfo.latest_version_clean}.`;
    }

    if (this.updateStatus.error) {
      return `Error checking for updates: ${this.updateStatus.error}. Click to retry.`;
    }

    const version = this.updateStatus.updateInfo?.current_version_clean;
    const versionText = version ? ` (v${version})` : '';
    return `Rclone is up to date${versionText}. Click to check for updates.`;
  }

  getStatusIcon(): string {
    if (this.updateStatus.available) return 'circle-up';
    if (this.updateStatus.error) return 'circle-exclamation';
    return 'circle-check';
  }

  getIconClass(): string {
    if (this.updateStatus.available) return 'primary';
    if (this.updateStatus.error) return 'warn';
    return 'accent';
  }

  handleStatusClick(): void {
    if (this.updateStatus.available) {
      this.showUpdateDialog();
    } else {
      this.checkForUpdates();
    }
  }

  isActionDisabled(): boolean {
    return this.updateStatus.checking || this.updateStatus.updating;
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

    const result = await firstValueFrom(dialogRef.afterClosed());
    if (result) {
      await this.updateService.performUpdate();
    }
  }
}

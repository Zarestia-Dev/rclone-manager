import { Component, HostListener, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { openUrl } from '@tauri-apps/plugin-opener';
import { MatDividerModule } from '@angular/material/divider';

// Services
import { RcloneUpdateInfo } from '@app/services';

export interface UpdateConfirmationData {
  updateInfo: RcloneUpdateInfo;
}

@Component({
  selector: 'app-update-confirmation-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatDialogModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatDividerModule,
  ],
  templateUrl: './update-confirmation-dialog.component.html',
  styleUrls: ['./update-confirmation-dialog.component.scss'],
})
export class UpdateConfirmationDialogComponent {
  private dialogRef = inject(MatDialogRef<UpdateConfirmationDialogComponent>);
  public data = inject<UpdateConfirmationData>(MAT_DIALOG_DATA);

  confirm(): void {
    this.dialogRef.close(true);
  }

  @HostListener('document:keydown.escape', ['$event'])
  cancel(): void {
    this.dialogRef.close(false);
  }

  formatDate(dateString: string): string {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return dateString;
    }
  }

  openLink(link: string): void {
    openUrl(link);
  }

  openChangelog(): void {
    this.openLink('https://rclone.org/changelog/');
  }
}

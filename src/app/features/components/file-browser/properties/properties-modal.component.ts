import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  MatDialogRef,
  MAT_DIALOG_DATA,
  MatDialogActions,
  MatDialogContent,
} from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { RemoteManagementService } from '@app/services';
import { Entry } from '@app/types';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';

@Component({
  selector: 'app-properties-modal',
  standalone: true,
  imports: [
    CommonModule,
    MatProgressSpinnerModule,
    MatIconModule,
    FormatFileSizePipe,
    MatDialogActions,
    MatDialogContent,
  ],
  template: `
    <div class="properties-container">
      <h2 mat-dialog-title>Properties</h2>
      <mat-dialog-content>
        <div *ngIf="isLoading" class="spinner-container">
          <mat-spinner></mat-spinner>
        </div>
        <div *ngIf="!isLoading && item">
          <p><strong>Name:</strong> {{ item.Name }}</p>
          <p><strong>Path:</strong> {{ item.Path }}</p>
          <p><strong>Size:</strong> {{ item.Size | formatFileSize }}</p>
          <p><strong>Modified:</strong> {{ item.ModTime | date: 'medium' }}</p>
          <p><strong>Is Directory:</strong> {{ item.IsDir }}</p>
          <p><strong>MIME Type:</strong> {{ item.MimeType }}</p>
          <div *ngIf="item.IsDir && size">
            <p><strong>Files in folder:</strong> {{ size.count }}</p>
          </div>
          <div *ngIf="diskUsage">
            <p><strong>Total Disk Space:</strong> {{ diskUsage.total || '0' }}</p>
            <p><strong>Used Disk Space:</strong> {{ diskUsage.used || '0' }}</p>
            <p><strong>Free Disk Space:</strong> {{ diskUsage.free || '0' }}</p>
          </div>
        </div>
      </mat-dialog-content>
      <mat-dialog-actions>
        <button mat-button (click)="close()">Close</button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [
    `
      .properties-container {
        width: 400px;
      }
      .spinner-container {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 200px;
      }
    `,
  ],
})
export class PropertiesModalComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<PropertiesModalComponent>);
  public data: { remoteName: string; path: string } = inject(MAT_DIALOG_DATA);
  private remoteManagementService = inject(RemoteManagementService);

  isLoading = true;
  item: Entry | null = null;
  size: { count: number; bytes: number } | null = null;
  diskUsage: { total?: number; used?: number; free?: number } | null = null;

  ngOnInit(): void {
    Promise.all([
      this.remoteManagementService.getStat(this.data.remoteName, this.data.path),
      this.remoteManagementService.getSize(this.data.remoteName, this.data.path),
      this.remoteManagementService.getDiskUsage(this.data.remoteName, this.data.path),
    ]).then(([stat, size, diskUsage]) => {
      this.item = stat.item;
      this.size = size;
      this.diskUsage = diskUsage;
      this.isLoading = false;
      console.log('Loaded properties:', { stat, size, diskUsage });
    });
  }

  close(): void {
    this.dialogRef.close();
  }
}

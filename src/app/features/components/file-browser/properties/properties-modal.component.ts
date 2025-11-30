import { Component, HostListener, OnInit, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { RemoteManagementService, NautilusService } from '@app/services'; // Switched to NautilusService
import { Entry } from '@app/types';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';
import { IconService } from 'src/app/shared/services/icon.service';

@Component({
  selector: 'app-properties-modal',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
    FormatFileSizePipe,
  ],
  templateUrl: './properties-modal.component.html',
  styleUrls: ['./properties-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class PropertiesModalComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<PropertiesModalComponent>);
  public data: { remoteName: string; path: string; fs_type: string; item?: Entry | null } =
    inject(MAT_DIALOG_DATA);

  private remoteManagementService = inject(RemoteManagementService);
  private nautilusService = inject(NautilusService);
  private iconService = inject(IconService);

  // Separate loading states
  loadingStat = true;
  loadingSize = true;
  loadingDiskUsage = true;

  item: Entry | null = null;
  size: { count: number; bytes: number } | null = null;
  diskUsage: { total?: number; used?: number; free?: number } | null = null;
  displayLocation = '';

  // Reactive Star State derived from Service
  isStarred = computed(() => this.nautilusService.isStarred(this.data.remoteName, this.data.path));

  ngOnInit(): void {
    const { remoteName, path, fs_type, item } = this.data;

    // Set the item immediately
    this.item = item ?? null;
    this.loadingStat = false;

    // Construct the display location string
    if (fs_type === 'local') {
      this.displayLocation = remoteName;
    } else {
      const sep = remoteName && !remoteName.endsWith(':') ? ':' : '';
      this.displayLocation = `${remoteName}${sep}${path}`;
    }

    const targetIsDir = this.item ? !!this.item.IsDir : true;

    // 1. Get Size/Count (if directory)
    if (targetIsDir) {
      this.remoteManagementService
        .getSize(remoteName, path)
        .then(size => {
          this.size = size;
          this.loadingSize = false;
        })
        .catch(err => {
          console.error('Failed to load size', err);
          this.loadingSize = false;
        });
    } else if (this.item) {
      this.size = { count: 1, bytes: this.item.Size };
      this.loadingSize = false;
    } else {
      this.loadingSize = false;
    }

    // 2. Get Disk Usage
    let diskUsageRemote = remoteName;
    let diskUsagePath = path;

    if (fs_type === 'local' && !(item && item.IsDir)) {
      const lastSlashIndex = remoteName.lastIndexOf('/');
      if (lastSlashIndex === 0) {
        diskUsageRemote = '/';
      } else if (lastSlashIndex > 0) {
        diskUsageRemote = remoteName.substring(0, lastSlashIndex);
      }
      diskUsagePath = '';
    }
    this.remoteManagementService
      .getDiskUsage(diskUsageRemote, diskUsagePath)
      .then(diskUsage => {
        this.diskUsage = diskUsage;
        this.loadingDiskUsage = false;
      })
      .catch(err => {
        console.error('Failed to load disk usage', err);
        this.loadingDiskUsage = false;
      });
  }

  toggleStar(): void {
    // 1. Ensure we have a valid Entry object
    const entryToSave: Entry = this.item ?? {
      Name: this.data.path.split('/').pop() || this.data.remoteName,
      Path: this.data.path,
      IsDir: true, // Default assumption for root/unknown types
      Size: 0,
      ModTime: new Date().toISOString(),
      ID: '',
      MimeType: 'inode/directory',
    };

    // 2. Construct the identifier string
    // Logic: If it's a remote (not local) and missing the colon, add it.
    let remoteIdentifier = this.data.remoteName;
    if (this.data.fs_type === 'remote' && !remoteIdentifier.endsWith(':')) {
      remoteIdentifier = `${remoteIdentifier}:`;
    }

    // 3. Call simplified service
    this.nautilusService.toggleStar(remoteIdentifier, entryToSave);
  }

  @HostListener('keydown.escape')
  close(): void {
    this.dialogRef.close();
  }

  getIcon(item?: Entry | null): string {
    if (!item) return 'folder';
    if (item.IsDir) return 'folder';
    return this.iconService.getIconForFileType(item.Name);
  }
}

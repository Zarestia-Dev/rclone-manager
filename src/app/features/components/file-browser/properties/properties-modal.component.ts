import { Component, HostListener, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { RemoteManagementService } from '@app/services';
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
  private iconService = inject(IconService);

  // Separate loading states
  loadingStat = true;
  loadingSize = true;
  loadingDiskUsage = true;

  item: Entry | null = null;
  size: { count: number; bytes: number } | null = null;
  diskUsage: { total?: number; used?: number; free?: number } | null = null;
  displayLocation = '';

  ngOnInit(): void {
    const { remoteName, path, fs_type, item } = this.data;

    // Set the item immediately from the data passed in (may be null for
    // background/context-root properties). Treat a null item as the current
    // directory (i.e., a directory context).
    this.item = item ?? null;
    this.loadingStat = false; // Basic stats are now pre-loaded.

    // Construct the display location string
    if (fs_type === 'local') {
      this.displayLocation = remoteName;
    } else {
      // Ensure a colon separator for remote paths when applicable
      const sep = remoteName && !remoteName.endsWith(':') ? ':' : '';
      this.displayLocation = `${remoteName}${sep}${path}`;
    }

    // Determine whether target should be treated as a directory.
    const targetIsDir = this.item ? !!this.item.IsDir : true;

    // If it's a directory (or background directory), get its recursive size.
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
      // If it's a file, we already have the size from the passed-in item.
      this.size = { count: 1, bytes: this.item.Size };
      this.loadingSize = false;
    } else {
      // No item and not a directory (shouldn't happen) — mark size loaded.
      this.loadingSize = false;
    }

    // 3. Get Disk Usage (this is separate and still needed)
    let diskUsageRemote = remoteName;
    let diskUsagePath = path;

    if (fs_type === 'local' && !(item && item.IsDir)) {
      // For a local file, the backend needs a directory to check disk usage.
      // We'll use the file's parent directory.
      const lastSlashIndex = remoteName.lastIndexOf('/');
      if (lastSlashIndex === 0) {
        // File in root directory, e.g., /file.txt. Parent is /.
        diskUsageRemote = '/';
      } else if (lastSlashIndex > 0) {
        // File in a subdirectory, e.g., /path/to/file.txt
        diskUsageRemote = remoteName.substring(0, lastSlashIndex);
      }
      diskUsagePath = ''; // Path is encoded in remoteName for local.
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

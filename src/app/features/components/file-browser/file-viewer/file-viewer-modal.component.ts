import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  HostListener,
  EventEmitter,
  Output,
  signal,
} from '@angular/core';

import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { catchError, takeUntil } from 'rxjs/operators';
import { Subject, of } from 'rxjs';
import {
  RemoteManagementService,
  PathSelectionService,
  JobManagementService,
  FileSystemService,
  UiStateService,
} from '@app/services';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import { IconService } from 'src/app/shared/services/icon.service';
import { NotificationService } from 'src/app/shared/services/notification.service';
import { FormatFileSizePipe } from '@app/pipes';
import { Entry } from '@app/types';

@Component({
  selector: 'app-file-viewer-modal',
  standalone: true,
  imports: [MatButtonModule, MatProgressSpinnerModule, MatIconModule, FormatFileSizePipe],
  templateUrl: './file-viewer-modal.component.html',
  styleUrls: ['./file-viewer-modal.component.scss'],
})
export class FileViewerModalComponent implements OnInit, OnDestroy {
  public data!: {
    items: Entry[];
    currentIndex: number;
    url: string;
    fileType: string;
    name: string;
    isLocal: boolean;
    remoteName: string;
  };

  private sanitizer = inject(DomSanitizer);
  private http = inject(HttpClient);
  private fileViewerService = inject(FileViewerService);
  public iconService = inject(IconService);
  private remoteManagementService = inject(RemoteManagementService);
  private readonly notificationService = inject(NotificationService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly uiStateService = inject(UiStateService);

  sanitizedUrl!: SafeResourceUrl;

  textContent = signal('');
  folderSize = signal<{ count: number; bytes: number } | null>(null);

  isLoading = signal(true);
  isDownloading = signal(false);

  // Cancel pending requests when component updates or destroys
  private destroy$ = new Subject<void>();
  private cancelCurrentRequest$ = new Subject<void>();

  @Output() closeViewer = new EventEmitter<void>();

  async ngOnInit(): Promise<void> {
    await this.updateContent();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.cancelCurrentRequest$.complete();
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowLeft':
        this.back();
        break;
      case 'ArrowRight':
        this.next();
        break;
      case 'Escape':
        this.closeViewer.emit();
        break;
    }
  }

  async updateContent(): Promise<void> {
    // Cancel any pending requests from previous navigation
    this.cancelCurrentRequest$.next();

    // Reset state immediately
    this.isLoading.set(true);
    this.textContent.set('');
    this.folderSize.set(null);
    try {
      if (this.data.fileType === 'directory') {
        const item = this.data.items[this.data.currentIndex];
        // Logic is now robust for any path structure.
        let fsName = this.data.remoteName;

        // If remote (not local), ensure it has the colon for the API call
        if (!this.data.isLocal) {
          fsName = this.pathSelectionService.normalizeRemoteForRclone(fsName);
        }

        // For local: fsName is "C:" or "/", path is "path/to/dir"
        // For remote: fsName is "gdrive:", path is "path/to/dir"
        await this.remoteManagementService
          .getSize(fsName, item.Path)
          .then((size: { count: number; bytes: number }) => {
            this.folderSize.set(size);
          })
          .catch(err => {
            console.error('Failed to get folder size:', err);
            this.notificationService.showError('Failed to calculate folder size');
          })
          .finally(() => {
            this.isLoading.set(false);
          });
        return;
      }

      this.sanitizedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.data.url);

      if (this.data.fileType === 'text') {
        this.http
          .get(this.data.url, {
            responseType: 'text',
            observe: 'response',
          })
          .pipe(
            takeUntil(this.cancelCurrentRequest$),
            takeUntil(this.destroy$),
            catchError(err => {
              console.error('Failed to load text file:', err);
              this.notificationService.showError('Failed to load file content');
              return of(null);
            })
          )
          .subscribe(response => {
            if (response && response.body) {
              this.textContent.set(response.body);
            }
            this.isLoading.set(false);
          });

        return;
      }

      // For other file types (image, video, audio, pdf), loading will be handled by onLoadComplete/onLoadError
      // For non-previewable files (default case), set loading to false immediately
      const previewableTypes = ['image', 'video', 'audio', 'pdf', 'text', 'directory'];
      if (!previewableTypes.includes(this.data.fileType)) {
        this.isLoading.set(false);
      }
    } catch (error) {
      console.error('Error updating content:', error);
      this.notificationService.showError('An unexpected error occurred');
      this.isLoading.set(false);
    }
  }

  // Fired by Image/Video/Audio/Iframe onload events
  onLoadComplete(): void {
    this.isLoading.set(false);
  }

  onLoadError(): void {
    this.isLoading.set(false);
    this.notificationService.showError(`Failed to load ${this.data.name}`);
    console.error('Failed to load file:', this.data.name);
  }

  async next(): Promise<void> {
    if (this.data.currentIndex < this.data.items.length - 1) {
      this.data.currentIndex++;
      await this.updateData();
    }
  }

  async back(): Promise<void> {
    if (this.data.currentIndex > 0) {
      this.data.currentIndex--;
      await this.updateData();
    }
  }

  async updateData(): Promise<void> {
    const item = this.data.items[this.data.currentIndex];
    this.data.name = item.Name;
    this.data.fileType = this.fileViewerService.getFileType(item);

    this.data.url = await this.fileViewerService.generateUrl(
      item,
      this.data.remoteName,
      this.data.isLocal
    );
    await this.updateContent();
  }

  /**
   * Download the current file to a selected destination using copyUrl
   * Opens a folder picker to let user choose where to save
   */
  async download(): Promise<void> {
    if (this.isDownloading()) return;

    this.isDownloading.set(true);

    try {
      // Let user select a local folder for download destination
      const selectedPath = await this.fileSystemService.selectFolder();

      // Build destination path with filename using OS-aware separator
      const fullDestPath = this.uiStateService.joinPath(selectedPath, this.data.name);

      // Start the copy job
      await this.jobManagementService.copyUrl(selectedPath, fullDestPath, this.data.url, true);

      this.notificationService.openSnackBar(`Downloading ${this.data.name}`, 'OK');
    } catch (err) {
      console.error('Failed to start download:', err);
    } finally {
      this.isDownloading.set(false);
    }
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.closeViewer.emit();
    }
  }
}

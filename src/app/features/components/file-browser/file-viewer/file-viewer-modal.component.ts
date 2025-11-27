import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  HostListener,
  EventEmitter,
  Output,
  signal,
  WritableSignal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { catchError, takeUntil } from 'rxjs/operators';
import { Subject, of } from 'rxjs';
import { Entry } from '@app/types';
import { FileViewerService } from '../../../../services/ui/file-viewer.service';
import { IconService } from 'src/app/shared/services/icon.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { FormatFileSizePipe } from '../../../../shared/pipes/format-file-size.pipe';
import { NotificationService } from 'src/app/shared/services/notification.service';

@Component({
  selector: 'app-file-viewer-modal',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatIconModule,
    FormatFileSizePipe,
  ],
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

  sanitizedUrl!: SafeResourceUrl;

  textContent: WritableSignal<string> = signal('');
  folderSize: WritableSignal<{ count: number; bytes: number } | null> = signal(null);

  isLoading: WritableSignal<boolean> = signal(true);

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

        if (this.data.remoteName === 'Local') {
          this.data.remoteName = `/${item.Path}`;
          item.Path = '';
        }

        await this.remoteManagementService
          .getSize(this.data.remoteName, item.Path)
          .then((size: { count: number; bytes: number }) => {
            this.folderSize.set(size);
            console.log('Folder size:', size);
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
    } catch (error) {
      console.error('Error updating content:', error);
      this.notificationService.showError('An unexpected error occurred');
    } finally {
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

  next(): void {
    if (this.data.currentIndex < this.data.items.length - 1) {
      this.data.currentIndex++;
      this.updateData();
    }
  }

  back(): void {
    if (this.data.currentIndex > 0) {
      this.data.currentIndex--;
      this.updateData();
    }
  }

  updateData(): void {
    const item = this.data.items[this.data.currentIndex];
    this.data.name = item.Name;
    this.data.fileType = this.fileViewerService.getFileType(item);
    this.data.url = this.fileViewerService.generateUrl(
      item,
      this.data.remoteName,
      this.data.isLocal ? 'local' : 'remote'
    );
    this.updateContent();
  }

  download(): void {
    /* empty */
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.closeViewer.emit();
    }
  }
}

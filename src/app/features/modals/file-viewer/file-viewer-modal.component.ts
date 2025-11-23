import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { Observable } from 'rxjs';

@Component({
  selector: 'app-file-viewer-modal',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatIconModule,
  ],
  template: `
    <div class="file-viewer-header">
      <span class="file-name">{{ data.name }}</span>
      <button mat-icon-button (click)="close()">
        <mat-icon>close</mat-icon>
      </button>
    </div>
    <mat-dialog-content>
      <div [ngSwitch]="data.fileType" class="content-container">
        <img
          *ngSwitchCase="'image'"
          [src]="sanitizedUrl"
          [alt]="data.name"
          class="preview-content"
        />
        <video
          *ngSwitchCase="'video'"
          [src]="sanitizedUrl"
          controls
          class="preview-content"
        ></video>
        <audio *ngSwitchCase="'audio'" [src]="sanitizedUrl" controls></audio>
        <iframe *ngSwitchCase="'pdf'" [src]="sanitizedUrl" width="100%" height="100%"></iframe>
        <pre *ngSwitchCase="'text'">{{ textContent$ | async }}</pre>
        <p *ngSwitchDefault>Unsupported file type for preview.</p>
      </div>
    </mat-dialog-content>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        background: transparent;
      }

      .file-viewer-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 24px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
      }

      .file-name {
        font-size: 1.2rem;
      }

      mat-dialog-content {
        flex-grow: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        overflow: hidden;
      }

      .content-container {
        display: flex;
        justify-content: center;
        align-items: center;
        width: 100%;
        height: 100%;
      }

      .preview-content {
        max-width: 90vw;
        max-height: 85vh;
        object-fit: contain;
      }

      pre {
        background: #222;
        color: #eee;
        padding: 20px;
        border-radius: 8px;
        max-width: 90vw;
        max-height: 85vh;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-all;
      }
    `,
  ],
})
export class FileViewerModalComponent implements OnInit {
  public data: { url: string; fileType: string; name: string } = inject(MAT_DIALOG_DATA);
  private sanitizer = inject(DomSanitizer);
  private dialogRef = inject(MatDialogRef<FileViewerModalComponent>);
  private http = inject(HttpClient);

  sanitizedUrl!: SafeResourceUrl;
  textContent$!: Observable<string>;

  ngOnInit(): void {
    this.sanitizedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.data.url);
    if (this.data.fileType === 'text') {
      this.textContent$ = this.http.get(this.data.url, { responseType: 'text' });
    }
  }

  close(): void {
    this.dialogRef.close();
  }
}

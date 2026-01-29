import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  HostListener,
  EventEmitter,
  Output,
  signal,
  computed,
} from '@angular/core';

import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { catchError, takeUntil } from 'rxjs/operators';
import { Subject, of } from 'rxjs';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import rust from 'highlight.js/lib/languages/rust';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import scss from 'highlight.js/lib/languages/scss';
import ini from 'highlight.js/lib/languages/ini';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('python', python);
hljs.registerLanguage('go', go);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('ini', ini);
import {
  RemoteManagementService,
  PathSelectionService,
  JobManagementService,
  FileSystemService,
  UiStateService,
} from '@app/services';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import { IconService } from '@app/services';
import { NotificationService } from '@app/services';
import { FormatFileSizePipe } from '@app/pipes';
import { Entry } from '@app/types';

@Component({
  selector: 'app-file-viewer-modal',
  standalone: true,
  imports: [
    MatButtonModule,
    MatProgressSpinnerModule,
    MatIconModule,
    FormatFileSizePipe,
    TranslateModule,
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
  private translate = inject(TranslateService);
  private remoteManagementService = inject(RemoteManagementService);
  private readonly notificationService = inject(NotificationService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly uiStateService = inject(UiStateService);

  sanitizedUrl!: SafeResourceUrl;

  textContent = signal('');
  folderSize = signal<{ count: number; bytes: number } | null>(null);
  fileSize = signal<number | null>(null);

  // Computed highlighted content for direct text view
  highlightedContent = computed(() => {
    const text = this.textContent();
    if (!text) return '';
    try {
      // Auto-detect language and highlight
      return hljs.highlightAuto(text).value;
    } catch (e) {
      console.warn('HighlightJS failed, returning raw text', e);
      return text;
    }
  });

  isLoading = signal(true);
  isDownloading = signal(false);

  // Markdown preview
  showMarkdownPreview = signal(false);
  renderedMarkdown = signal('');

  // Cancel pending requests when component updates or destroys
  private destroy$ = new Subject<void>();
  private cancelCurrentRequest$ = new Subject<void>();

  @Output() closeViewer = new EventEmitter<void>();

  async ngOnInit(): Promise<void> {
    // Initialize file size for the first item
    const item = this.data.items[this.data.currentIndex];
    this.fileSize.set(item.Size ?? null);
    await this.updateContent();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.cancelCurrentRequest$.complete();
  }

  /**
   * Check if file is markdown
   */
  isMarkdownFile(): boolean {
    const name = this.data.name.toLowerCase();
    return name.endsWith('.md') || name.endsWith('.markdown');
  }

  /**
   * Toggle markdown preview
   */
  async toggleMarkdownPreview(): Promise<void> {
    if (!this.showMarkdownPreview() && this.textContent()) {
      const item = this.data.items[this.data.currentIndex];
      let content = this.textContent();

      // Helper to handle async replacements
      const replaceAsync = async (
        str: string,
        regex: RegExp,
        asyncFn: (match: string, ...args: any[]) => Promise<string>
      ): Promise<string> => {
        const promises: Promise<string>[] = [];
        str.replace(regex, (match, ...args) => {
          promises.push(asyncFn(match, ...args));
          return match;
        });
        const data = await Promise.all(promises);
        return str.replace(regex, () => data.shift() ?? '');
      };

      // Markdown Images: ![alt](path)
      content = await replaceAsync(
        content,
        /!\[([^\]]*)\]\((?!https?:\/\/)([^)]+)\)/g,
        async (_, alt, path) => {
          const res = await this.fileViewerService.resolveRelativePath(
            item,
            this.data.remoteName,
            this.data.isLocal,
            path
          );
          return `![${alt}](${res})`;
        }
      );

      // Markdown Links: [text](path)
      content = await replaceAsync(
        content,
        /\[([^\]]+)\]\((?!https?:\/\/)([^)]+)\)/g,
        async (_, text, path) => {
          const res = await this.fileViewerService.resolveRelativePath(
            item,
            this.data.remoteName,
            this.data.isLocal,
            path
          );
          return `[${text}](${res})`;
        }
      );

      // HTML Images: <img src="path">
      content = await replaceAsync(
        content,
        /<img([^>]*)\ssrc=["']([^"']+)["']/gi,
        async (_, attrs, path) => {
          const res = await this.fileViewerService.resolveRelativePath(
            item,
            this.data.remoteName,
            this.data.isLocal,
            path
          );
          return `<img${attrs} src="${res}"`;
        }
      );

      // HTML Links: <a href="path">
      content = await replaceAsync(
        content,
        /<a([^>]*)\shref=["']([^"']+)["']/gi,
        async (_, attrs, path) => {
          const res = await this.fileViewerService.resolveRelativePath(
            item,
            this.data.remoteName,
            this.data.isLocal,
            path
          );
          return `<a${attrs} href="${res}"`;
        }
      );

      this.renderedMarkdown.set(marked.parse(content) as string);
    }
    this.showMarkdownPreview.update(v => !v);
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
            this.notificationService.showError(
              this.translate.instant('fileBrowser.fileViewer.errorCalculateSize')
            );
          })
          .finally(() => {
            this.isLoading.set(false);
          });
        return;
      }

      if (this.data.fileType === 'binary') {
        // Show "Cannot preview" immediately - no download needed
        this.isLoading.set(false);
        return;
      }

      this.sanitizedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.data.url);

      // Text-based files: try to load as text, browser will handle what it can
      const textTypes = ['text', 'previewable'];
      if (textTypes.includes(this.data.fileType)) {
        this.http
          .get(this.data.url, {
            responseType: 'text',
            observe: 'response',
          })
          .pipe(
            takeUntil(this.cancelCurrentRequest$),
            takeUntil(this.destroy$),
            catchError(err => {
              // Failed to load - probably binary
              console.warn('Browser cannot render file:', err);
              this.data.fileType = 'binary';
              return of(null);
            })
          )
          .subscribe(res => {
            if (res?.body) {
              // Check if content looks like binary after loading
              if (this.looksLikeBinary(res.body)) {
                this.data.fileType = 'binary';
              } else {
                this.textContent.set(res.body);
              }
            }
            this.isLoading.set(false);
          });
        return;
      }

      // For media types (image, video, audio, pdf), loading handled by element events
      const mediaTypes = ['image', 'video', 'audio', 'pdf'];
      if (!mediaTypes.includes(this.data.fileType)) {
        this.isLoading.set(false);
      }
    } catch (error) {
      console.error('Error updating content:', error);
      this.notificationService.showError(
        this.translate.instant('fileBrowser.fileViewer.errorUnexpected')
      );
      this.isLoading.set(false);
    }
  }

  /**
   * Check if text content appears to be binary data.
   * Uses NULL byte detection and non-printable character ratio.
   */
  private looksLikeBinary(content: string): boolean {
    // Quick check: NULL byte is definitive binary indicator
    if (content.includes('\0')) return true;

    // Count non-printable characters (excluding whitespace)
    let nonPrintable = 0;
    const maxCheck = Math.min(content.length, 1024); // Only check first 1KB for performance

    for (let i = 0; i < maxCheck; i++) {
      const code = content.charCodeAt(i);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        nonPrintable++;
      }
    }

    // If >30% non-printable, likely binary
    return nonPrintable / maxCheck > 0.3;
  }

  // Fired by Image/Video/Audio/Iframe onload events
  onLoadComplete(): void {
    this.isLoading.set(false);
  }

  onLoadError(): void {
    this.isLoading.set(false);
    this.notificationService.showError(
      this.translate.instant('fileBrowser.fileViewer.errorLoadFile', { name: this.data.name })
    );
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
    this.data.fileType = await this.fileViewerService.getFileType(
      item,
      this.data.remoteName,
      this.data.isLocal
    );
    this.fileSize.set(item.Size ?? null);

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

      this.notificationService.openSnackBar(
        this.translate.instant('fileBrowser.fileViewer.downloading', { name: this.data.name }),
        'OK'
      );
    } catch (err) {
      console.error('Failed to start download:', err);
    } finally {
      this.isDownloading.set(false);
    }
  }
}

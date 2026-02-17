import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  HostListener,
  EventEmitter,
  Output,
  signal,
  ViewChild,
  ElementRef,
} from '@angular/core';

import { DomSanitizer, SafeResourceUrl, SafeHtml } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { catchError, takeUntil } from 'rxjs/operators';
import { Subject, of } from 'rxjs';
import { marked } from 'marked';

// CodeMirror Imports
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { javascript as cmJavascript } from '@codemirror/lang-javascript';
import { json as cmJson } from '@codemirror/lang-json';
import { css as cmCss } from '@codemirror/lang-css';
import { html as cmHtml } from '@codemirror/lang-html';
import { python as cmPython } from '@codemirror/lang-python';
import { markdown as cmMarkdown } from '@codemirror/lang-markdown';
import { rust as cmRust } from '@codemirror/lang-rust';
import { sql as cmSql } from '@codemirror/lang-sql';
import { yaml as cmYaml } from '@codemirror/lang-yaml';
import { go as legacyGo } from '@codemirror/legacy-modes/mode/go';
import { shell as legacyShell } from '@codemirror/legacy-modes/mode/shell';

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

import { FormsModule } from '@angular/forms';
import { MatTooltip } from '@angular/material/tooltip';

// ── GNOME / Adwaita Light Syntax Highlighting ──
// Colors inspired by GNOME Builder's light theme and Adwaita palette
const gnomeLightHighlighting = HighlightStyle.define([
  { tag: tags.keyword, color: '#0d7377' }, // Teal — keywords (if, const, return)
  { tag: tags.controlKeyword, color: '#0d7377', fontWeight: '500' },
  { tag: tags.definitionKeyword, color: '#0d7377' },
  { tag: tags.moduleKeyword, color: '#0d7377' },
  { tag: tags.function(tags.variableName), color: '#1a5fb4' }, // Blue — function names
  { tag: tags.function(tags.definition(tags.variableName)), color: '#1a5fb4', fontWeight: '500' },
  { tag: tags.string, color: '#c64600' }, // Orange — strings
  { tag: tags.number, color: '#813d9c' }, // Purple — numbers
  { tag: tags.bool, color: '#813d9c' },
  { tag: tags.null, color: '#813d9c', fontStyle: 'italic' },
  { tag: tags.comment, color: '#5e5c64', fontStyle: 'italic' }, // Dim gray — comments
  { tag: tags.lineComment, color: '#5e5c64', fontStyle: 'italic' },
  { tag: tags.blockComment, color: '#5e5c64', fontStyle: 'italic' },
  { tag: tags.typeName, color: '#1a5fb4' }, // Blue — types
  { tag: tags.className, color: '#1a5fb4', fontWeight: '500' },
  { tag: tags.propertyName, color: '#26a269' }, // Green — properties
  { tag: tags.definition(tags.propertyName), color: '#26a269' },
  { tag: tags.variableName, color: '#241f31' }, // Near-black — variables
  { tag: tags.definition(tags.variableName), color: '#241f31' },
  { tag: tags.operator, color: '#0d7377' }, // Teal — operators
  { tag: tags.punctuation, color: '#77767b' }, // Gray — punctuation
  { tag: tags.bracket, color: '#5e5c64' },
  { tag: tags.meta, color: '#813d9c' }, // Purple — decorators / meta
  { tag: tags.attributeName, color: '#26a269' }, // Green — HTML/XML attributes
  { tag: tags.attributeValue, color: '#c64600' }, // Orange — attribute values
  { tag: tags.tagName, color: '#1a5fb4' }, // Blue — HTML/XML tags
  { tag: tags.heading, color: '#1a5fb4', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.link, color: '#1a5fb4', textDecoration: 'underline' },
  { tag: tags.url, color: '#1a5fb4' },
  { tag: tags.regexp, color: '#a51d2d' }, // Red — regex
  { tag: tags.escape, color: '#a51d2d' },
  { tag: tags.special(tags.string), color: '#a51d2d' },
]);

@Component({
  selector: 'app-file-viewer-modal',
  standalone: true,
  imports: [
    MatButtonModule,
    MatProgressSpinnerModule,
    MatIconModule,
    FormatFileSizePipe,
    TranslateModule,
    FormsModule,
    MatTooltip,
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

  isLoading = signal(true);
  isDownloading = signal(false);

  // Markdown preview
  showMarkdownPreview = signal(false);
  renderedMarkdown = signal<SafeHtml>('');

  // Editing state
  isEditing = signal(false);
  editContent = signal('');
  isSaving = signal(false);

  @ViewChild('editorContainer') editorContainer!: ElementRef<HTMLDivElement>;
  private editorView: EditorView | null = null;

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
   * Start editing the current file
   */
  startEditing(): void {
    this.editContent.set(this.textContent());
    this.isEditing.set(true);
    this.showMarkdownPreview.set(false);

    // Re-initialize as editable
    setTimeout(() => this.initEditor(false, this.editContent()), 0);
  }

  /**
   * Cancel editing
   */
  cancelEditing(): void {
    this.isEditing.set(false);
    this.editContent.set('');

    // Re-initialize as read-only with original content
    setTimeout(() => this.initEditor(true, this.textContent()), 0);
  }

  private initEditor(readOnly = true, content = ''): void {
    if (this.editorView) {
      this.editorView.destroy();
      this.editorView = null;
    }

    if (!this.editorContainer) return;

    // Detect current theme
    const isDark = document.documentElement.classList.contains('dark');

    const extensions = [
      basicSetup,
      ...(isDark ? [oneDark] : [syntaxHighlighting(gnomeLightHighlighting)]),
      keymap.of([]),
      EditorView.editable.of(!readOnly),
      EditorState.readOnly.of(readOnly),
    ];

    if (!readOnly) {
      extensions.push(
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            this.editContent.set(update.state.doc.toString());
          }
        })
      );
    }

    // Detect language based on extension
    const ext = this.data.name.split('.').pop()?.toLowerCase() || '';
    switch (ext) {
      case 'js':
        extensions.push(cmJavascript());
        break;
      case 'ts':
        extensions.push(cmJavascript({ typescript: true }));
        break;
      case 'json':
        extensions.push(cmJson());
        break;
      case 'css':
      case 'scss':
      case 'sass':
        extensions.push(cmCss());
        break;
      case 'html':
      case 'htm':
        extensions.push(cmHtml());
        break;
      case 'xml':
        extensions.push(cmHtml());
        break;
      case 'py':
        extensions.push(cmPython());
        break;
      case 'rs':
        extensions.push(cmRust());
        break;
      case 'yaml':
      case 'yml':
        extensions.push(cmYaml());
        break;
      case 'sql':
        extensions.push(cmSql());
        break;
      case 'go':
        extensions.push(StreamLanguage.define(legacyGo));
        break;
      case 'sh':
      case 'bash':
      case 'zsh':
        extensions.push(StreamLanguage.define(legacyShell));
        break;
      case 'md':
      case 'markdown':
        extensions.push(cmMarkdown());
        break;
      default:
        extensions.push(cmMarkdown());
        break;
    }

    const state = EditorState.create({
      doc: content,
      extensions: extensions,
    });

    this.editorView = new EditorView({
      state,
      parent: this.editorContainer.nativeElement,
    });
  }

  /**
   * Save changes to remote
   */
  async saveChanges(): Promise<void> {
    if (this.isSaving()) return;

    this.isSaving.set(true);
    const item = this.data.items[this.data.currentIndex];

    try {
      const fsName = this.data.isLocal
        ? this.data.remoteName
        : this.pathSelectionService.normalizeRemoteForRclone(this.data.remoteName);

      const lastSlashIndex = item.Path.lastIndexOf('/');
      const dirPath = lastSlashIndex > -1 ? item.Path.substring(0, lastSlashIndex) : '';
      const filename = lastSlashIndex > -1 ? item.Path.substring(lastSlashIndex + 1) : item.Path;

      await this.remoteManagementService.uploadFile(
        fsName,
        dirPath,
        filename,
        this.editContent(),
        'nautilus'
      );

      this.textContent.set(this.editContent());
      this.isEditing.set(false);
      this.fileSize.set(new Blob([this.editContent()]).size);
      this.notificationService.showSuccess(
        this.translate.instant('fileBrowser.fileViewer.saveSuccess')
      );
    } catch (error) {
      console.error('Failed to save file:', error);
      this.notificationService.showError(
        this.translate.instant('fileBrowser.fileViewer.saveError')
      );
    } finally {
      this.isSaving.set(false);
    }
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

      this.renderedMarkdown.set(
        this.sanitizer.bypassSecurityTrustHtml(marked.parse(content) as string)
      );
    }

    this.showMarkdownPreview.update(v => !v);

    // If switching back to raw view, re-initialize CodeMirror
    if (!this.showMarkdownPreview()) {
      setTimeout(() => this.initEditor(true, this.textContent()), 0);
    } else if (this.editorView) {
      // Destroy editor when showing preview to save resources and avoid state desync
      this.editorView.destroy();
      this.editorView = null;
    }
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
    this.isEditing.set(false);
    this.editContent.set('');
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
              if (this.looksLikeBinary(res.body)) {
                this.data.fileType = 'binary';
              } else {
                this.textContent.set(res.body);
                // Initialize CodeMirror in read-only mode
                setTimeout(() => this.initEditor(true, res.body ?? ''), 0);
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

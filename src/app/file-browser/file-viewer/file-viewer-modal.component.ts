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
  ViewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { HttpClient } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { catchError, takeUntil } from 'rxjs/operators';
import { Subject, of, firstValueFrom } from 'rxjs';
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
  RemoteFileOperationsService,
  PathSelectionService,
  JobManagementService,
  FileSystemService,
  NautilusService,
} from '@app/services';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import { IconService } from '@app/services';
import { NotificationService } from '@app/services';
import { FormatFileSizePipe } from '@app/pipes';
import { Entry, ORIGINS, FilePickerResult } from '@app/types';

import { FormsModule } from '@angular/forms';
import { MatTooltip } from '@angular/material/tooltip';
import { isHeadlessMode } from 'src/app/services/infrastructure/platform/api-client.service';

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
    CommonModule,
  ],
  templateUrl: './file-viewer-modal.component.html',
  styleUrls: ['./file-viewer-modal.component.scss'],
})
export class FileViewerModalComponent implements OnInit, OnDestroy {
  private static readonly FILE_OPERATION_ORIGIN = ORIGINS.FILEMANAGER;

  public data!: {
    items: Entry[];
    currentIndex: number;
    url: string;
    isLocal: boolean;
    remoteName: string;
  };

  private sanitizer = inject(DomSanitizer);
  private http = inject(HttpClient);
  private fileViewerService = inject(FileViewerService);
  public iconService = inject(IconService);
  private translate = inject(TranslateService);
  private remoteOps = inject(RemoteFileOperationsService);
  private readonly nautilusService = inject(NautilusService);
  private readonly notificationService = inject(NotificationService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly readJobGroup = `ui/file-viewer/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  public currentUrl = signal<string>('');

  safePdfUrl = computed(() => {
    const url = this.currentUrl();
    if (!url) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });

  currentIndex = signal(0);
  currentItem = computed(() => this.data.items[this.currentIndex()]);
  fileName = computed(() => this.currentItem().Name);
  fileSize = computed(() => this.currentItem().Size ?? null);
  textContent = signal('');
  folderSize = signal<{ count: number; bytes: number } | null>(null);
  coverImage = signal<string | null>(null);
  rawUrl = signal<string>('');
  fileCategory = computed(() => this.iconService.getFileTypeCategory(this.currentItem()));
  currentFileType = signal<string>('text');

  isLoading = signal(true);
  isDownloading = signal(false);
  isLoadingCover = signal(false);
  archiveContent = signal<string>('');
  parsedArchiveItems = signal<
    { size: number; date: string; time: string; path: string; isDir: boolean }[]
  >([]);
  isExtracting = signal(false);
  archiveError = signal<string | null>(null);
  errorMessage = signal<string | null>(null);

  // Editing state
  isEditing = signal(false);
  editContent = signal('');

  // Markdown preview
  showMarkdownPreview = signal(false);
  renderedMarkdown = signal<SafeHtml>('');

  isSaving = signal(false);

  isMarkdownFile = computed(() => {
    const name = this.fileName().toLowerCase();
    return name.endsWith('.md') || name.endsWith('.markdown');
  });

  @ViewChild('editorContainer') editorContainer!: ElementRef<HTMLDivElement>;
  private editorView: EditorView | null = null;

  // Cancel pending requests when component updates or destroys
  private destroy$ = new Subject<void>();
  private cancelCurrentRequest$ = new Subject<void>();

  @Output() closeViewer = new EventEmitter<void>();

  ngOnInit(): void {
    this.currentIndex.set(this.data.currentIndex);
    this.updateData();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.cancelCurrentRequest$.complete();
    void this.stopReadJobs();
  }

  private async stopReadJobs(): Promise<void> {
    try {
      await this.jobManagementService.stopJobsByGroup(this.readJobGroup);
    } catch (err) {
      console.debug('Failed to stop file viewer read jobs:', err);
    }
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
    const ext = this.fileName().split('.').pop()?.toLowerCase() || '';
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
    const item = this.currentItem();

    try {
      const fsName = this.data.isLocal
        ? this.data.remoteName
        : this.pathSelectionService.normalizeRemoteForRclone(this.data.remoteName);

      const lastSlashIndex = item.Path.lastIndexOf('/');
      const dirPath = lastSlashIndex > -1 ? item.Path.substring(0, lastSlashIndex) : '';
      const filename = lastSlashIndex > -1 ? item.Path.substring(lastSlashIndex + 1) : item.Path;

      const content = new TextEncoder().encode(this.editContent());
      await this.remoteOps.uploadFileSimple(fsName, dirPath, filename, content);

      this.textContent.set(this.editContent());
      this.isEditing.set(false);

      this.notificationService.showInfo(
        this.translate.instant('fileBrowser.fileViewer.saveSuccess')
      );
    } catch (error) {
      console.error('Failed to save file:', error);
      this.notificationService.showError(
        this.translate.instant('fileBrowser.fileViewer.saveError'),
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.isSaving.set(false);
    }
  }

  /**
   * Toggle markdown preview
   */
  async toggleMarkdownPreview(): Promise<void> {
    if (!this.showMarkdownPreview() && this.textContent()) {
      const item = this.currentItem();
      let content = this.textContent();

      // Helper to handle async replacements
      const replaceAsync = async (
        str: string,
        regex: RegExp,
        asyncFn: (match: string, ...args: string[]) => Promise<string>
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
    if (this.isEditing()) return;

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

  async updateData(): Promise<void> {
    await this.stopReadJobs();

    const item = this.currentItem();

    // 1. Immediately reset state entirely, clear URLs so media elements unmount.
    this.cancelCurrentRequest$.next();
    this.isLoading.set(true);
    this.currentUrl.set('');
    this.textContent.set('');
    this.folderSize.set(null);
    this.coverImage.set(null);
    this.isLoadingCover.set(false);
    this.isEditing.set(false);
    this.editContent.set('');
    this.archiveContent.set('');
    this.archiveError.set(null);
    this.errorMessage.set(null);

    try {
      const [type, url] = await Promise.all([
        this.fileViewerService.getFileType(item, this.data.remoteName, this.data.isLocal),
        this.fileViewerService.generateUrl(item, this.data.remoteName, this.data.isLocal),
      ]);

      this.currentFileType.set(type);
      this.rawUrl.set(url);

      await this.updateContent();
    } catch (err) {
      console.error('Failed to update data:', err);
      this.isLoading.set(false);
    }
  }

  async updateContent(): Promise<void> {
    try {
      if (this.currentFileType() === 'directory') {
        const item = this.currentItem();
        // Logic is now robust for any path structure.
        let fsName = this.data.remoteName;

        // If remote (not local), ensure it has the colon for the API call
        if (!this.data.isLocal) {
          fsName = this.pathSelectionService.normalizeRemoteForRclone(fsName);
        }

        // For local: fsName is "C:" or "/", path is "path/to/dir"
        // For remote: fsName is "gdrive:", path is "path/to/dir"
        await this.remoteOps
          .getSize(fsName, item.Path, 'filemanager', this.readJobGroup)
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

      if (this.fileCategory() === 'binary' || this.currentFileType() === 'binary') {
        // Show "Cannot preview" immediately - no download needed
        this.isLoading.set(false);
        return;
      }

      // Text-based files: try to load as text, browser will handle what it can
      if (this.fileCategory() === 'text') {
        this.http
          .get(this.rawUrl(), {
            responseType: 'text',
            observe: 'response',
          })
          .pipe(
            takeUntil(this.cancelCurrentRequest$),
            takeUntil(this.destroy$),
            catchError(err => {
              console.warn('Browser cannot render file:', err);
              this.currentFileType.set('error');
              const body = err.error instanceof Blob ? 'Binary data' : err.error;
              this.errorMessage.set(body || err.message || 'Unknown error');
              return of(null);
            })
          )
          .subscribe(res => {
            if (res?.body) {
              if (this.looksLikeBinary(res.body)) {
                // Special handling for LNK files to show target info even if binary
                if (this.fileName().toLowerCase().endsWith('.lnk')) {
                  const info = this.extractLnkInfo(res.body);
                  this.textContent.set(info);
                  setTimeout(() => this.initEditor(true, info), 0);
                } else {
                  this.currentFileType.set('binary');
                }
              } else {
                const repaired = this.repairText(res.body);
                this.textContent.set(repaired);
                // Initialize CodeMirror in read-only mode
                setTimeout(() => this.initEditor(true, repaired ?? ''), 0);
              }
            }
            this.isLoading.set(false);
          });
        return;
      }

      if (this.currentFileType() === 'audio') {
        this.isLoadingCover.set(true);
        this.fileViewerService
          .getAudioCover(this.currentItem(), this.data.remoteName, this.data.isLocal)
          .then(cover => {
            this.coverImage.set(cover);
          })
          .catch(err => {
            console.warn('Failed to extract audio cover:', err);
          })
          .finally(() => {
            this.isLoadingCover.set(false);
          });
      }

      if (this.currentFileType() === 'archive') {
        const item = this.currentItem();
        const source = this.data.isLocal
          ? (this.data.remoteName === '/'
              ? `/${item.Path}`
              : `${this.data.remoteName}/${item.Path}`
            ).replace(/\/+/g, '/')
          : `${this.pathSelectionService.normalizeRemoteForRclone(this.data.remoteName)}${item.Path}`;

        this.remoteOps
          .archiveList(source, true) // Use long format for more info
          .then(res => {
            if (res && res.success) {
              this.archiveContent.set(res.output);
              this.parsedArchiveItems.set(this.parseArchiveList(res.output));
              this.archiveError.set(null);
            } else if (res) {
              this.archiveError.set(res.output);
              this.parsedArchiveItems.set([]);
            }
          })
          .catch(err => {
            console.error('Failed to list archive:', err);
            this.archiveError.set(err.toString());
            this.archiveContent.set(
              this.translate.instant('fileBrowser.fileViewer.errorListArchive')
            );
            this.parsedArchiveItems.set([]);
          })
          .finally(() => {
            this.isLoading.set(false);
          });
        return;
      }
      const mediaTypes = ['image', 'video', 'audio', 'pdf'];
      if (mediaTypes.includes(this.currentFileType())) {
        this.currentUrl.set(this.rawUrl());
      }
      if (!['image', 'video', 'audio'].includes(this.currentFileType())) {
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

  private parseArchiveList(
    output: string
  ): { size: number; date: string; time: string; path: string; isDir: boolean }[] {
    if (!output) return [];

    const lines = output.trim().split('\n');
    return lines
      .map(line => {
        // Format: "        6 2025-10-30 09:46:23.000000000 file.txt"
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) return null;

        const size = parseInt(parts[0], 10);
        const date = parts[1];
        const time = parts[2];
        const path = parts.slice(3).join(' ');

        return {
          size: isNaN(size) ? 0 : size,
          date,
          time: time.split('.')[0],
          path,
          isDir: path.endsWith('/'),
        };
      })
      .filter(item => item !== null) as any[];
  }

  /**
   * Check if text content appears to be binary data.
   * Uses NULL byte detection and non-printable character ratio.
   */
  private looksLikeBinary(content: string): boolean {
    if (!content) return false;

    // Check for common BOMs (Byte Order Marks) which often indicate UTF-16/32 text
    // UTF-16 LE: FF FE, UTF-16 BE: FE FF, UTF-8: EF BB BF
    const firstTwo = content.substring(0, 2);
    if (firstTwo === '\xFF\xFE' || firstTwo === '\xFE\xFF' || content.startsWith('\xEF\xBB\xBF')) {
      return false; // Definitely text
    }

    // NULL byte detection with UTF-16 heuristic:
    // If NULL bytes are frequent but alternating with printable chars, it's likely UTF-16.
    let nullCount = 0;
    const maxCheck = Math.min(content.length, 1024);
    for (let i = 0; i < maxCheck; i++) {
      if (content.charCodeAt(i) === 0) nullCount++;
    }

    // If more than 10% are NULL but content is large, or if any NULL in first few bytes of non-UTF-16
    // But let's be more practical: if NULL count is extremely high (> 40%), it's probably binary.
    // If NULLs are present but the ratio is exactly around 50%, it's likely UTF-16 text.
    const nullRatio = nullCount / maxCheck;
    if (nullRatio > 0.1 && (nullRatio < 0.4 || nullRatio > 0.6)) return true;

    // Count non-printable characters (excluding whitespace and common text control chars)
    let nonPrintable = 0;
    for (let i = 0; i < maxCheck; i++) {
      const code = content.charCodeAt(i);
      if (code === 0) continue; // Handled by nullRatio
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        nonPrintable++;
      }
    }

    // Windows Shortcut (LNK) magic bytes: 4C 00 00 00
    if (maxCheck >= 4 && content.startsWith('L\0\0\0')) {
      return true;
    }

    // If >30% non-printable (excluding NULLs), likely binary
    return nonPrintable / (maxCheck - nullCount) > 0.3;
  }

  /**
   * Extremely basic LNK (Windows Shortcut) parser.
   * Scans the binary content for likely target paths or descriptions.
   */
  private extractLnkInfo(content: string): string {
    // Look for Windows-style paths (e.g. C:\...) or environment variables
    const pathRegex = /[a-zA-Z]:\\[^ \ufffd\0\r\n\t]+(?:\.exe|\.dll|\.lnk|\.bat|\.cmd)/gi;
    const envRegex = /%[a-zA-Z0-9_]+%\\[^ \ufffd\0\r\n\t]+/gi;

    const paths = new Set<string>();
    let match;

    while ((match = pathRegex.exec(content)) !== null) {
      paths.add(match[0]);
    }
    while ((match = envRegex.exec(content)) !== null) {
      paths.add(match[0]);
    }

    if (paths.size > 0) {
      let result = this.translate.instant('fileBrowser.fileViewer.shortcutTargets') + ':\n\n';
      paths.forEach(p => (result += `- ${p}\n`));
      return result;
    }

    return content;
  }

  /**
   * Detects and repairs mangled UTF-16 text.
   * Rclone cat returns raw bytes which can be misinterpreted as UTF-8 strings
   * with embedded NULL bytes for UTF-16 encoded files (like Windows desktop.ini).
   */
  private repairText(content: string): string {
    if (!content) return content;

    let nullCount = 0;
    const maxCheck = Math.min(content.length, 1024);
    for (let i = 0; i < maxCheck; i++) {
      if (content.charCodeAt(i) === 0) nullCount++;
    }

    const nullRatio = nullCount / maxCheck;

    // If it's around 50% NULLs, it's almost certainly mangled UTF-16 text
    if (nullRatio > 0.4 && nullRatio < 0.6) {
      console.debug('Repairing mangled UTF-16 text...');
      // 1. Remove the mangled BOM (replacement characters) if present
      const repaired = content.replace(/^\ufffd\ufffd/, '');
      // 2. Strip all NULL bytes - for ASCII range in UTF-16 this restores the text
      return repaired.replace(/\0/g, '');
    }

    return content;
  }

  // Fired by Image/Video/Audio/Iframe onload events
  onLoadComplete(): void {
    this.isLoading.set(false);
  }

  onLoadError(): void {
    this.isLoading.set(false);
    this.currentFileType.set('error');

    // Default generic message
    this.errorMessage.set(
      this.translate.instant('fileBrowser.fileViewer.errorLoadFile', { name: this.fileName() })
    );

    // Try to fetch the specific error message from the protocol handler (e.g. Locked, Permission Denied)
    this.http
      .get(this.rawUrl(), { responseType: 'text' })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        error: err => {
          const body = err.error instanceof Blob ? 'Binary data' : err.error;
          if (body && typeof body === 'string' && body.length < 500) {
            this.errorMessage.set(body);
          }
        },
      });

    console.error('Failed to load file:', this.fileName());
  }

  async back(): Promise<void> {
    if (this.currentIndex() > 0) {
      this.currentIndex.update(i => i - 1);
      await this.updateData();
    }
  }

  async next(): Promise<void> {
    if (this.currentIndex() < this.data.items.length - 1) {
      this.currentIndex.update(i => i + 1);
      await this.updateData();
    }
  }

  /**
   * Download the current file to a selected destination using copyFile
   * Opens a folder picker to let user choose where to save
   */
  async download(): Promise<void> {
    if (this.isDownloading()) return;

    if (isHeadlessMode()) {
      try {
        const url = new URL(this.rawUrl());
        url.searchParams.set('download', 'true');

        const link = document.createElement('a');
        link.href = url.toString();
        link.download = this.fileName();
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        this.notificationService.showInfo(
          this.translate.instant('fileBrowser.fileViewer.downloading', { name: this.fileName() })
        );
      } catch (err) {
        console.error('Failed to trigger browser download:', err);
        this.notificationService.showError(
          this.translate.instant('fileBrowser.fileViewer.errorDownload')
        );
      }
      return;
    }

    this.isDownloading.set(true);

    try {
      // Let user select a local folder for download destination
      const selectedPath = await this.fileSystemService.selectFolder();

      // Start the copy job
      const fsName = this.data.isLocal
        ? this.data.remoteName
        : this.pathSelectionService.normalizeRemoteForRclone(this.data.remoteName);

      await this.remoteOps.transferItems(
        [
          {
            remote: fsName,
            path: this.currentItem().Path,
            name: this.fileName(),
            isDir: false,
          },
        ],
        selectedPath,
        '',
        'copy',
        ORIGINS.FILEMANAGER
      );

      this.notificationService.showInfo(
        this.translate.instant('fileBrowser.fileViewer.downloading', { name: this.fileName() })
      );
    } catch (err) {
      console.error('Failed to start download:', err);
    } finally {
      this.isDownloading.set(false);
    }
  }

  async extractArchive(): Promise<void> {
    if (this.isExtracting()) return;

    const item = this.currentItem();

    // Use internal Nautilus picker for folder selection
    this.nautilusService.openFilePicker({
      selection: 'folders',
      mode: 'both', // Allow picking both local and remote folders
      multi: false,
    });

    try {
      const result: FilePickerResult = await firstValueFrom(this.nautilusService.filePickerResult$);
      if (result.cancelled || !result.paths.length) return;

      this.isExtracting.set(true);
      const selectedPath = result.paths[0];

      const source = this.data.isLocal
        ? (this.data.remoteName === '/'
            ? `/${item.Path}`
            : `${this.data.remoteName}/${item.Path}`
          ).replace(/\/+/g, '/')
        : `${this.pathSelectionService.normalizeRemoteForRclone(this.data.remoteName)}${item.Path}`;

      this.notificationService.showInfo(
        this.translate.instant('fileBrowser.fileViewer.extracting', { name: this.fileName() })
      );

      await this.remoteOps.archiveExtract(source, selectedPath);
    } catch (err) {
      console.error('Failed to extract archive:', err);
      this.notificationService.showError(
        this.translate.instant('fileBrowser.fileViewer.errorExtract')
      );
    } finally {
      this.isExtracting.set(false);
    }
  }
}

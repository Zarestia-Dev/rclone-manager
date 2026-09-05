import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  HostListener,
  output,
  signal,
  computed,
  viewChild,
  ElementRef,
  ChangeDetectionStrategy,
} from '@angular/core';

import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { TranslateService, TranslatePipe } from '@ngx-translate/core';
import { HttpClient, HttpHeaders, HttpErrorResponse } from '@angular/common/http';
import { MatIconModule } from '@angular/material/icon';
import { catchError, takeUntil } from 'rxjs/operators';
import { Subject, of, firstValueFrom } from 'rxjs';
import { marked } from 'marked';

// CodeMirror Imports
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Extension, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';

import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { DownloadService } from 'src/app/services/operations/download.service';
import { OpenerService } from 'src/app/services/infrastructure/platform/opener.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import {
  BinaryInspectorService,
  DetectedSignature,
  HexDumpRow,
} from 'src/app/services/ui/binary-inspector.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { FormatFileSizePipe } from '@app/pipes';
import { Entry, FilePickerResult, ArchiveListItem } from '@app/types';

import {
  isHeadlessMode,
  isMobile,
} from 'src/app/services/infrastructure/platform/api-client.service';

@Component({
  selector: 'app-file-viewer-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, FormatFileSizePipe, TranslatePipe],
  templateUrl: './file-viewer-modal.component.html',
  styleUrls: ['./file-viewer-modal.component.scss'],
})
export class FileViewerModalComponent implements OnInit, OnDestroy {
  public data!: {
    items: Entry[];
    currentIndex: number;
    url: string;
    isLocal: boolean;
    remoteName: string;
    isDirectUrl?: boolean;
  };

  private readonly sanitizer = inject(DomSanitizer);
  private readonly http = inject(HttpClient);
  private readonly fileViewerService = inject(FileViewerService);
  private readonly downloadService = inject(DownloadService);
  private readonly openerService = inject(OpenerService);
  private readonly backendService = inject(BackendService);
  public readonly iconService = inject(IconService);
  private readonly translate = inject(TranslateService);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly nautilusService = inject(NautilusService);
  private readonly notificationService = inject(NotificationService);
  private readonly pathService = inject(PathService);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly binaryInspector = inject(BinaryInspectorService);
  private readonly readJobGroup = `ui/file-viewer/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  private activeProbeImg: HTMLImageElement | null = null;
  private lastRenderedText: string | null = null;

  public currentUrl = signal<string>('');
  public readonly detectedSignature = signal<DetectedSignature | null>(null);
  public readonly hexDumpRows = signal<HexDumpRow[]>([]);

  // Zoom & Pan state for image preview
  zoomLevel = signal(1);
  panX = signal(0);
  panY = signal(0);
  isDragging = signal(false);
  private startDragX = 0;
  private startDragY = 0;
  private initialPanX = 0;
  private initialPanY = 0;

  zoomPercentage = computed(() => `${Math.round(this.zoomLevel() * 100)}%`);
  imageTransform = computed(
    () => `translate(${this.panX()}px, ${this.panY()}px) scale(${this.zoomLevel()})`
  );
  imageCursor = computed(() =>
    this.zoomLevel() > 1 ? (this.isDragging() ? 'grabbing' : 'grab') : 'default'
  );

  safePdfUrl = computed(() => {
    const url = this.currentUrl();
    if (!url) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });

  currentIndex = signal(0);
  currentItem = computed(() => this.data?.items?.[this.currentIndex()] ?? null);
  fileName = computed(() => this.currentItem()?.Name ?? '');
  fileSize = computed(() => this.currentItem()?.Size ?? null);
  textContent = signal('');
  folderSize = signal<{ count: number; bytes: number } | null>(null);
  coverImage = signal<string | null>(null);
  rawUrl = signal<string>('');
  fileCategory = computed(() => {
    const item = this.currentItem();
    return item ? this.iconService.getFileTypeCategory(item) : 'text';
  });
  currentFileType = signal<string>('text');
  isHeadless = computed(() => isHeadlessMode());

  /** Normalized filesystem name for rclone API calls. */
  private get fsName(): string {
    return this.data.isLocal
      ? this.data.remoteName
      : this.pathService.normalizeRemoteForRclone(this.data.remoteName);
  }
  isMobile = computed(() => isMobile());
  isDownloadVisible = computed(() => {
    if (this.data.isDirectUrl) {
      return false;
    }
    return (
      this.isHeadless() || !this.data.isLocal || this.backendService.activeBackend() !== 'Local'
    );
  });

  isLoading = signal(true);
  isDownloading = signal(false);
  isOpeningNative = signal(false);
  isLoadingCover = signal(false);
  parsedArchiveItems = signal<ArchiveListItem[]>([]);
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

  readonly editorContainer = viewChild<ElementRef<HTMLDivElement>>('editorContainer');
  private editorView: EditorView | null = null;
  private readonly readOnlyCompartment = new Compartment();
  private readonly editableCompartment = new Compartment();

  // Cancel pending requests when component updates or destroys
  private cancelCurrentRequest$ = new Subject<void>();

  readonly closeViewer = output<void>();

  ngOnInit(): void {
    this.currentIndex.set(this.data.currentIndex);
    this.updateData();
  }

  ngOnDestroy(): void {
    this.cancelProbeImg();
    this.cancelCurrentRequest$.next();
    this.cancelCurrentRequest$.complete();
    void this.stopReadJobs();
    if (this.editorView) {
      this.editorView.destroy();
      this.editorView = null;
    }
    this.fileViewerService.setActiveFileName(null);
  }

  private cancelProbeImg(): void {
    if (this.activeProbeImg) {
      this.activeProbeImg.onload = null;
      this.activeProbeImg.onerror = null;
      this.activeProbeImg.src = '';
      this.activeProbeImg = null;
    }
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
    this.setEditorReadOnly(false, this.editContent());
  }

  /**
   * Cancel editing
   */
  cancelEditing(): void {
    this.isEditing.set(false);
    this.editContent.set('');
    this.setEditorReadOnly(true, this.textContent());
  }

  private setEditorReadOnly(readOnly: boolean, content?: string): void {
    if (!this.editorView) {
      this.safeInitEditor(readOnly, content ?? this.textContent());
      return;
    }

    const effects = [
      this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
      this.editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
    ];

    if (content !== undefined && content !== this.editorView.state.doc.toString()) {
      this.editorView.dispatch({
        changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
        effects,
      });
    } else {
      this.editorView.dispatch({ effects });
    }
  }

  private async initEditor(readOnly = true, content = ''): Promise<void> {
    if (this.currentFileType() !== 'text' || this.showMarkdownPreview()) {
      return;
    }

    if (this.editorView) {
      this.editorView.destroy();
      this.editorView = null;
    }

    const editorContainer = this.editorContainer();
    if (!editorContainer) return;

    // Detect current theme
    const extensions: Extension[] = [
      basicSetup,
      EditorView.theme({}, { dark: document.documentElement.classList.contains('dark') }),
      keymap.of([]),
      this.editableCompartment.of(EditorView.editable.of(!readOnly)),
      this.readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
      EditorView.updateListener.of(update => {
        if (update.docChanged && this.isEditing()) {
          this.editContent.set(update.state.doc.toString());
        }
      }),
    ];

    // Lazy-load the language extension matching the file extension.
    // Only the actually needed language pack is dynamically imported,
    // keeping the main bundle ~100 KB lighter.
    const ext = this.fileName().split('.').pop()?.toLowerCase() || '';
    const langExt = await this.loadLanguageExtension(ext);
    if (langExt) extensions.push(langExt);

    const state = EditorState.create({
      doc: content,
      extensions: extensions,
    });

    this.editorView = new EditorView({
      state,
      parent: editorContainer.nativeElement,
    });
  }

  private async loadLanguageExtension(ext: string): Promise<Extension | null> {
    switch (ext) {
      case 'js': {
        const { javascript } = await import('@codemirror/lang-javascript');
        return javascript();
      }
      case 'ts': {
        const { javascript } = await import('@codemirror/lang-javascript');
        return javascript({ typescript: true });
      }
      case 'json': {
        const { json } = await import('@codemirror/lang-json');
        return json();
      }
      case 'css':
      case 'scss':
      case 'sass': {
        const { css } = await import('@codemirror/lang-css');
        return css();
      }
      case 'html':
      case 'htm':
      case 'xml': {
        const { html } = await import('@codemirror/lang-html');
        return html();
      }
      case 'py': {
        const { python } = await import('@codemirror/lang-python');
        return python();
      }
      case 'rs': {
        const { rust } = await import('@codemirror/lang-rust');
        return rust();
      }
      case 'yaml':
      case 'yml': {
        const { yaml } = await import('@codemirror/lang-yaml');
        return yaml();
      }
      case 'sql': {
        const { sql } = await import('@codemirror/lang-sql');
        return sql();
      }
      case 'go': {
        const { go } = await import('@codemirror/legacy-modes/mode/go');
        return StreamLanguage.define(go);
      }
      case 'sh':
      case 'bash':
      case 'zsh': {
        const { shell } = await import('@codemirror/legacy-modes/mode/shell');
        return StreamLanguage.define(shell);
      }
      case 'md':
      case 'markdown': {
        const { markdown } = await import('@codemirror/lang-markdown');
        return markdown();
      }
      default:
        return null;
    }
  }

  /**
   * Save changes to remote
   */
  async saveChanges(): Promise<void> {
    if (this.isSaving()) return;

    this.isSaving.set(true);
    const item = this.currentItem();

    try {
      const dirPath = this.pathService.getDirname(item.Path);
      const filename = this.pathService.getFilename(item.Path);

      const content = new TextEncoder().encode(this.editContent());
      await this.remoteOps.uploadFileSimple(this.fsName, dirPath, filename, content);

      this.textContent.set(this.editContent());
      this.lastRenderedText = null;
      this.isEditing.set(false);
      this.setEditorReadOnly(true, this.textContent());

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
      if (!item) return;

      const currentText = this.textContent();
      if (this.lastRenderedText !== currentText || !this.renderedMarkdown()) {
        let content = currentText;
        const resolveCache = new Map<string, Promise<string>>();

        const resolveRelative = (path: string): Promise<string> => {
          let cached = resolveCache.get(path);
          if (!cached) {
            cached = this.fileViewerService.resolveRelativePath(
              item,
              this.data.remoteName,
              this.data.isLocal,
              path
            );
            resolveCache.set(path, cached);
          }
          return cached;
        };

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
          async (_, alt, path) => `![${alt}](${await resolveRelative(path)})`
        );

        // Markdown Links: [text](path)
        content = await replaceAsync(
          content,
          /\[([^\]]+)\]\((?!https?:\/\/)([^)]+)\)/g,
          async (_, text, path) => `[${text}](${await resolveRelative(path)})`
        );

        // HTML Images: <img src="path">
        content = await replaceAsync(
          content,
          /<img([^>]*)\ssrc=["']([^"']+)["']/gi,
          async (_, attrs, path) => `<img${attrs} src="${await resolveRelative(path)}"`
        );

        // HTML Links: <a href="path">
        content = await replaceAsync(
          content,
          /<a([^>]*)\shref=["']([^"']+)["']/gi,
          async (_, attrs, path) => `<a${attrs} href="${await resolveRelative(path)}"`
        );

        this.renderedMarkdown.set(
          this.sanitizer.bypassSecurityTrustHtml(marked.parse(content) as string)
        );
        this.lastRenderedText = currentText;
      }
    }

    this.showMarkdownPreview.update(v => !v);

    // If switching back to raw view, re-initialize CodeMirror
    if (!this.showMarkdownPreview()) {
      this.safeInitEditor(true, this.textContent());
    } else if (this.editorView) {
      // Destroy editor when showing preview to save resources and avoid state desync
      this.editorView.destroy();
      this.editorView = null;
    }
  }

  zoomIn(): void {
    this.zoomLevel.update(z => Math.min(5, Math.round((z + 0.25) * 100) / 100));
  }

  zoomOut(): void {
    this.zoomLevel.update(z => {
      const next = Math.max(0.25, Math.round((z - 0.25) * 100) / 100);
      if (next <= 1) {
        this.panX.set(0);
        this.panY.set(0);
      }
      return next;
    });
  }

  resetZoom(): void {
    this.zoomLevel.set(1);
    this.panX.set(0);
    this.panY.set(0);
    this.isDragging.set(false);
  }

  onImageWheel(event: WheelEvent): void {
    if (this.currentFileType() !== 'image') return;
    event.preventDefault();
    if (event.deltaY < 0) {
      this.zoomIn();
    } else if (event.deltaY > 0) {
      this.zoomOut();
    }
  }

  onImageMouseDown(event: MouseEvent): void {
    if (this.zoomLevel() <= 1 || event.button !== 0) return;
    event.preventDefault();
    this.isDragging.set(true);
    this.startDragX = event.clientX;
    this.startDragY = event.clientY;
    this.initialPanX = this.panX();
    this.initialPanY = this.panY();
  }

  onImageMouseMove(event: MouseEvent): void {
    if (!this.isDragging()) return;
    event.preventDefault();
    const dx = event.clientX - this.startDragX;
    const dy = event.clientY - this.startDragY;
    this.panX.set(this.initialPanX + dx);
    this.panY.set(this.initialPanY + dy);
  }

  onImageMouseUp(): void {
    this.isDragging.set(false);
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
      case '+':
      case '=':
        if (this.currentFileType() === 'image') {
          this.zoomIn();
        }
        break;
      case '-':
      case '_':
        if (this.currentFileType() === 'image') {
          this.zoomOut();
        }
        break;
      case '0':
        if (this.currentFileType() === 'image') {
          this.resetZoom();
        }
        break;
    }
  }

  async updateData(): Promise<void> {
    await this.stopReadJobs();

    const item = this.currentItem();
    this.fileViewerService.setActiveFileName(item ? item.Name : null);

    // 1. Immediately reset state entirely, clear URLs so media elements unmount.
    this.cancelProbeImg();
    this.cancelCurrentRequest$.next();
    this.lastRenderedText = null;
    this.detectedSignature.set(null);
    this.hexDumpRows.set([]);
    this.isLoading.set(true);
    this.currentFileType.set('loading');
    this.currentUrl.set('');
    this.textContent.set('');
    this.folderSize.set(null);
    this.coverImage.set(null);
    this.isLoadingCover.set(false);
    this.isEditing.set(false);
    this.editContent.set('');
    this.archiveError.set(null);
    this.errorMessage.set(null);
    this.resetZoom();

    try {
      const url = this.data.isDirectUrl
        ? this.data.url
        : await this.fileViewerService.generateUrl(item, this.data.remoteName, this.data.isLocal);
      const type = this.fileCategory();

      this.currentFileType.set(type);
      this.rawUrl.set(url);

      if (this.data.isDirectUrl) {
        if (type === 'image' || type === 'video' || type === 'audio' || type === 'pdf') {
          this.currentUrl.set(url);
          if (type === 'pdf') {
            this.isLoading.set(false);
          }
          return;
        }

        // For non-media or extensionless URLs (e.g. Unsplash dynamic images), probe image loading first
        const probeImg = new Image();
        this.activeProbeImg = probeImg;
        probeImg.referrerPolicy = 'no-referrer';
        probeImg.onload = (): void => {
          if (this.activeProbeImg === probeImg && this.rawUrl() === url) {
            this.activeProbeImg = null;
            this.currentFileType.set('image');
            this.currentUrl.set(url);
            this.isLoading.set(false);
          }
        };
        probeImg.onerror = (): void => {
          if (this.activeProbeImg === probeImg && this.rawUrl() === url) {
            this.activeProbeImg = null;
            this.isLoading.set(false);
          }
        };
        probeImg.src = url;
        return;
      }

      await this.updateContent();
    } catch (err) {
      console.error('Failed to update data:', err);
      this.isLoading.set(false);
    }
  }

  async updateContent(): Promise<void> {
    if (this.data.isDirectUrl) return;
    try {
      if (this.currentFileType() === 'directory') {
        const item = this.currentItem();
        if (!item) return;

        // For local: fsName is "C:" or "/", path is "path/to/dir"
        // For remote: fsName is "gdrive:", path is "path/to/dir"
        try {
          const size = await this.remoteOps.getSize(
            this.fsName,
            item.Path,
            'filemanager',
            this.readJobGroup
          );
          this.folderSize.set(size);
        } catch (err) {
          console.error('Failed to get folder size:', err);
          this.notificationService.showError(
            this.translate.instant('fileBrowser.fileViewer.errorCalculateSize')
          );
        } finally {
          this.isLoading.set(false);
        }
        return;
      }

      // Content-inspectable files: text files or binary files (for hex preview & signature detection)
      if (this.fileCategory() === 'text' || this.fileCategory() === 'binary') {
        const isKnownBinary = this.fileCategory() === 'binary';
        // For binary files, request only the first 64KB via Range header to be fast and avoid large downloads
        const headers = isKnownBinary
          ? new HttpHeaders({ Range: 'bytes=0-65535' })
          : new HttpHeaders();

        this.http
          .get(this.rawUrl(), {
            headers,
            responseType: 'arraybuffer',
            observe: 'response',
          })
          .pipe(
            takeUntil(this.cancelCurrentRequest$),
            catchError(err => {
              console.warn('Browser cannot render file:', err);
              this.currentFileType.set('error');
              this.errorMessage.set(this.extractErrorMessage(err));
              return of(null);
            })
          )
          .subscribe(res => {
            if (res?.body) {
              const uint8 = new Uint8Array(res.body);
              const inspection = this.binaryInspector.inspect(uint8, this.fileName());

              if (inspection.isBinary) {
                // Special handling for LNK files to show target info even if binary
                if (inspection.shortcutTargets && inspection.shortcutTargets.length > 0) {
                  const info = this.binaryInspector.extractLnkSummary(
                    uint8,
                    this.translate.instant('fileBrowser.fileViewer.shortcutTargets')
                  );
                  this.textContent.set(info);
                  this.safeInitEditor(true, info);
                  this.currentFileType.set('text');
                } else {
                  this.detectedSignature.set(inspection.signature);
                  this.hexDumpRows.set(inspection.hexDump ?? []);
                  this.currentFileType.set('binary');
                }
              } else {
                this.currentFileType.set('text');
                const text = this.binaryInspector.decodeText(uint8);
                this.textContent.set(text);
                // Initialize CodeMirror in read-only mode
                this.safeInitEditor(true, text);
              }
            }
            this.isLoading.set(false);
          });
        return;
      }

      if (this.currentFileType() === 'audio') {
        const item = this.currentItem();
        if (item) {
          const targetPath = item.Path;
          this.isLoadingCover.set(true);
          try {
            const cover = await this.fileViewerService.getAudioCover(
              item,
              this.data.remoteName,
              this.data.isLocal
            );
            if (this.isStillViewing(targetPath)) {
              this.coverImage.set(cover);
            }
          } catch (err) {
            console.warn('Failed to extract audio cover:', err);
          } finally {
            if (this.isStillViewing(targetPath)) {
              this.isLoadingCover.set(false);
            }
          }
        }
      }

      if (this.currentFileType() === 'archive') {
        const item = this.currentItem();
        if (!item) return;
        const targetPath = item.Path;
        const source = this.getArchiveSource(item);

        try {
          const res = await this.remoteOps.archiveList(source, true); // Use long format for more info
          if (!this.isStillViewing(targetPath)) return;
          if (res?.success) {
            this.parsedArchiveItems.set(res.items);
            this.archiveError.set(null);
          } else {
            this.archiveError.set('Unknown error');
            this.parsedArchiveItems.set([]);
          }
        } catch (err) {
          if (!this.isStillViewing(targetPath)) return;
          console.error('Failed to list archive:', err);
          this.archiveError.set(err instanceof Error ? err.message : String(err));
          this.parsedArchiveItems.set([]);
        } finally {
          if (this.isStillViewing(targetPath)) {
            this.isLoading.set(false);
          }
        }
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

  // Fired by Image/Video/Audio/Iframe onload events
  onLoadComplete(): void {
    this.isLoading.set(false);
  }

  onLoadError(event?: Event): void {
    this.isLoading.set(false);
    this.currentFileType.set('error');

    // Default generic message
    this.errorMessage.set(
      this.translate.instant('fileBrowser.fileViewer.errorLoadFile', { name: this.fileName() })
    );

    const mediaError = (event?.target as HTMLMediaElement)?.error;
    console.error(
      'Failed to load file:',
      this.fileName(),
      'Event:',
      event,
      'MediaError:',
      mediaError ? { code: mediaError.code, message: mediaError.message } : 'N/A'
    );
  }

  /**
   * Extracts a human-readable error string from an unknown error or HttpErrorResponse,
   * properly decoding ArrayBuffer error payloads without displaying '[object ArrayBuffer]'.
   */
  private extractErrorMessage(err: unknown): string {
    if (err instanceof HttpErrorResponse || (err && typeof err === 'object' && 'status' in err)) {
      const httpErr = err as HttpErrorResponse;
      let message = '';

      const isArrayBuffer =
        httpErr.error instanceof ArrayBuffer ||
        Object.prototype.toString.call(httpErr.error) === '[object ArrayBuffer]';

      const rawBytes = isArrayBuffer
        ? new Uint8Array(httpErr.error as ArrayBuffer)
        : ArrayBuffer.isView(httpErr.error)
          ? new Uint8Array(httpErr.error.buffer, httpErr.error.byteOffset, httpErr.error.byteLength)
          : null;

      if (rawBytes) {
        try {
          const decoded = new TextDecoder('utf-8').decode(rawBytes).replace(/\0/g, '').trim();
          if (decoded && !decoded.startsWith('<!DOCTYPE') && !decoded.startsWith('<html')) {
            message = decoded;
          }
        } catch {
          // ignore decode failure
        }
      } else if (typeof httpErr.error === 'string' && httpErr.error.trim()) {
        const trimmed = httpErr.error.replace(/\0/g, '').trim();
        if (!trimmed.startsWith('<!DOCTYPE') && !trimmed.startsWith('<html')) {
          message = trimmed;
        }
      } else if (httpErr.error && typeof httpErr.error === 'object' && 'message' in httpErr.error) {
        message = String((httpErr.error as { message: unknown }).message || '');
      }

      if (message) return message;

      if (httpErr.status) {
        const match = httpErr.message?.match(/:\s*(\d{3}\s+.*)$/);
        return match ? match[1] : `HTTP ${httpErr.status}`;
      }
      return httpErr.message || 'Unknown error';
    }

    if (err instanceof Error) {
      return err.message;
    }

    return typeof err === 'string' ? err : 'Unknown error';
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
   * Download the current file using the DownloadService
   */
  async download(): Promise<void> {
    if (this.data.isDirectUrl) {
      await this.openerService.openUrl(this.data.url);
      return;
    }
    if (this.isDownloading()) return;
    this.isDownloading.set(true);
    try {
      await this.downloadService.download(
        this.fsName,
        this.currentItem().Path,
        this.fileName(),
        this.data.isLocal,
        this.fileSize() || undefined
      );
    } catch (err) {
      console.error('Failed to download file:', err);
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
      const source = this.getArchiveSource(item);

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

  /**
   * Open the current file natively using Android / system default application intent
   */
  async openNativePdf(): Promise<void> {
    if (this.isOpeningNative()) return;
    this.isOpeningNative.set(true);
    try {
      await this.downloadService.openFileNatively(
        this.fsName,
        this.currentItem().Path,
        this.fileName(),
        this.data.isLocal
      );
    } catch (err) {
      console.error('Failed to open file natively:', err);
    } finally {
      this.isOpeningNative.set(false);
    }
  }

  /** Checks whether the viewer is still showing the file at the given path (stale-navigation guard). */
  private isStillViewing(targetPath: string): boolean {
    return this.currentItem()?.Path === targetPath;
  }

  /** Builds the full rclone source path for archive operations. */
  private getArchiveSource(item: Entry): string {
    return this.data.isLocal
      ? this.pathService.joinPath(this.data.remoteName, item.Path)
      : `${this.pathService.normalizeRemoteForRclone(this.data.remoteName)}${item.Path}`;
  }

  /** Schedules editor initialization after the next render, swallowing init errors. */
  private safeInitEditor(readOnly: boolean, content: string): void {
    requestAnimationFrame(() => {
      void this.initEditor(readOnly, content).catch(e => console.error('initEditor failed', e));
    });
  }
}

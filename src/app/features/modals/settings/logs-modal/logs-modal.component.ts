import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DatePipe, UpperCasePipe } from '@angular/common';
import { LogContext, RemoteLogEntry, LOG_LEVELS, LogLevel } from '@app/types';
import { LoggingService, BackendTranslationService, ModalService } from '@app/services';
import { AnsiToHtmlPipe } from 'src/app/shared/pipes/ansi-to-html.pipe';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-logs-modal',
  standalone: true,
  imports: [
    MatProgressSpinnerModule,
    MatIconModule,
    MatFormFieldModule,
    MatSelectModule,
    MatInputModule,
    FormsModule,
    MatSnackBarModule,
    MatButtonModule,
    MatTooltipModule,
    AnsiToHtmlPipe,
    DatePipe,
    UpperCasePipe,
    TranslateModule,
  ],
  templateUrl: './logs-modal.component.html',
  styleUrls: ['./logs-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogsModalComponent implements OnInit {
  // --- Dependencies ---
  private readonly dialogRef = inject(MatDialogRef<LogsModalComponent>);
  public readonly data = inject(MAT_DIALOG_DATA) as { remoteName: string };
  private readonly snackBar = inject(MatSnackBar);
  private readonly loggingService = inject(LoggingService);
  private readonly backendTranslation = inject(BackendTranslationService);
  private readonly modalService = inject(ModalService);
  private readonly translate = inject(TranslateService);
  private readonly injector = inject(Injector);

  public readonly logLevels = LOG_LEVELS;

  // --- State Signals ---
  readonly logs = signal<RemoteLogEntry[]>([]);
  readonly loading = signal(false);
  readonly selectedLevel = signal<LogLevel | ''>('');
  readonly searchText = signal<string>('');
  readonly expandedLogs = signal<Set<string>>(new Set());

  // --- Computed Logic ---
  readonly filteredLogs = computed(() => {
    const allLogs = this.logs();
    const level = this.selectedLevel();
    const search = this.searchText().toLowerCase();

    return allLogs.filter(log => {
      const matchesLevel = level ? log.level === level : true;
      const matchesSearch = search
        ? log.message.toLowerCase().includes(search) ||
          (log.context && JSON.stringify(log.context).toLowerCase().includes(search))
        : true;
      return matchesLevel && matchesSearch;
    });
  });

  readonly terminalLogArea = viewChild<ElementRef<HTMLDivElement>>('terminalLogArea');

  ngOnInit(): void {
    this.loadLogs();
  }

  async loadLogs(): Promise<void> {
    this.loading.set(true);
    try {
      const fetchedLogs = (await this.loggingService.getRemoteLogs(
        this.data.remoteName
      )) as unknown as RemoteLogEntry[];
      this.logs.set(fetchedLogs);
      afterNextRender(() => this.scrollToBottom(), { injector: this.injector });
    } catch {
      const message = this.translate.instant('modals.logs.fetchError');
      this.snackBar.open(message, undefined, { duration: 3000 });
    } finally {
      this.loading.set(false);
    }
  }

  async clearLogs(): Promise<void> {
    this.loading.set(true);
    try {
      await this.loggingService.clearRemoteLogs(this.data.remoteName);
      this.logs.set([]);
    } catch {
      const message = this.translate.instant('modals.logs.clearError');
      this.snackBar.open(message, undefined, { duration: 3000 });
    } finally {
      this.loading.set(false);
    }
  }

  // --- Log Parsing Helpers ---
  getLogId(log: RemoteLogEntry): string {
    return `${log.timestamp}-${log.message.substring(0, 15)}`;
  }

  isExpanded(log: RemoteLogEntry): boolean {
    return this.expandedLogs().has(this.getLogId(log));
  }

  toggleDetails(log: RemoteLogEntry): void {
    if (!log.context) return;
    const id = this.getLogId(log);
    this.expandedLogs.update(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Smart extractor for Rclone's nested error outputs.
   * Handles the specific bisync error structure: status -> output -> output
   */
  getCommandOutput(log: RemoteLogEntry): string | null {
    if (!log.context) return null;

    const ctx = log.context as any;

    if (ctx?.status?.output?.output) return ctx.status.output.output;
    if (typeof ctx?.output === 'string') return ctx.output;
    if (ctx?.output && typeof ctx.output === 'object') return JSON.stringify(ctx.output, null, 2);

    return null;
  }

  formatContext(context: LogContext): string {
    try {
      const displayContext = { ...context } as any;
      if (typeof displayContext.response === 'string') {
        try {
          displayContext.response = JSON.parse(displayContext.response);
        } catch {
          /* not valid JSON, keep as-is */
        }
      }
      return JSON.stringify(displayContext, null, 2);
    } catch (e) {
      console.error('Error formatting log context:', e);
      return JSON.stringify(context, null, 2);
    }
  }

  translateLogMessage(message: string): string {
    return this.backendTranslation.translateBackendMessage(message);
  }

  async copyLog(log: RemoteLogEntry): Promise<void> {
    const output = this.getCommandOutput(log);
    const translatedMessage = this.translateLogMessage(log.message);
    let text = `[${log.timestamp}] [${log.level.toUpperCase()}] ${translatedMessage}`;

    if (output) {
      // eslint-disable-next-line no-control-regex
      const cleanOutput = output.replace(/\u001b\[\d+;?\d*m/g, '');
      text += `\n\nOutput:\n${cleanOutput}`;
    }

    if (log.context) {
      text += `\n\nDetails:\n${this.formatContext(log.context)}`;
    }

    try {
      await navigator.clipboard.writeText(text);
      this.snackBar.open(this.translate.instant('modals.logs.copiedToClipboard'), undefined, {
        duration: 2000,
      });
    } catch (error) {
      console.error('Failed to copy log to clipboard:', error);
      this.snackBar.open(this.translate.instant('modals.common.errorCopied'), undefined, {
        duration: 2000,
      });
    }
  }

  scrollToBottom(): void {
    this.terminalLogArea()?.nativeElement.scrollTo({
      top: Number.MAX_SAFE_INTEGER,
      behavior: 'smooth',
    });
  }

  scrollToTop(): void {
    this.terminalLogArea()?.nativeElement.scrollTo({ top: 0, behavior: 'smooth' });
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }
}

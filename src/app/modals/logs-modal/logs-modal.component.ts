import {
  Component,
  ElementRef,
  OnInit,
  ViewChild,
  AfterViewChecked,
  Inject,
  HostListener,
  ChangeDetectorRef,
  OnDestroy,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from "@angular/material/dialog";
import { MatListModule } from "@angular/material/list";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatIconModule } from "@angular/material/icon";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatSelectModule } from "@angular/material/select";
import { CommonModule } from "@angular/common";
import { RcloneService } from "../../services/rclone.service";
import { MatInputModule } from "@angular/material/input";
import { MatSnackBar, MatSnackBarModule } from "@angular/material/snack-bar";
import { MatButtonModule } from "@angular/material/button";
import { MatTooltipModule } from "@angular/material/tooltip";

export interface LogContext {
  job_id?: number;
  response?: string;
  [key: string]: any;
}

export interface RemoteLogEntry {
  timestamp: string;
  remote_name?: string;
  level: string;
  message: string;
  context?: LogContext | null;
}

@Component({
  selector: "app-logs-modal",
  standalone: true,
  imports: [
    CommonModule,
    MatListModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatFormFieldModule,
    MatSelectModule,
    MatInputModule,
    FormsModule,
    MatSnackBarModule,
    MatButtonModule,
    MatTooltipModule,
  ],
  templateUrl: "./logs-modal.component.html",
  styleUrl: "./logs-modal.component.scss",
})
export class LogsModalComponent implements OnInit, OnDestroy {
  logs: RemoteLogEntry[] = [];
  loading = false;
  selectedLevel: string = "";
  searchText: string = "";
  selectedRemote: string = "";
  autoScroll = true;
  expandedLogs = new Set<string>();

  @ViewChild("terminalLogArea") terminalLogArea?: ElementRef<HTMLDivElement>;

  constructor(
    private rcloneService: RcloneService,
    private dialogRef: MatDialogRef<LogsModalComponent>,
    @Inject(MAT_DIALOG_DATA) public data: { remoteName: string },
    private snackBar: MatSnackBar,
    private cdRef: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.loadSavedFilters();
    this.loadLogs();
  }

  ngOnDestroy() {
  }

  get uniqueRemotes(): string[] {
    return [...new Set(this.logs.map(log => log.remote_name).filter(Boolean))] as string[];
  }

  get filteredLogs(): RemoteLogEntry[] {
    let logs = this.logs;
    if (this.selectedLevel) {
      logs = logs.filter((log) => log.level === this.selectedLevel);
    }
    if (this.selectedRemote) {
      logs = logs.filter((log) => log.remote_name === this.selectedRemote);
    }
    if (this.searchText) {
      const searchLower = this.searchText.toLowerCase();
      logs = logs.filter((log) =>
        log.message.toLowerCase().includes(searchLower) ||
        (log.context && JSON.stringify(log.context).toLowerCase().includes(searchLower))
      );
    }
    return logs;
  }

  async loadLogs() {
    this.loading = true;
    try {
      this.logs = (await this.rcloneService.getRemoteLogs(
        this.data.remoteName
      )) as unknown as RemoteLogEntry[];
    } finally {
      this.loading = false;
    }
  }

  async clearLogs() {
    this.loading = true;
    try {
      await this.rcloneService.clearRemoteLogs(this.data.remoteName);
      this.logs = [];
    } finally {
      this.loading = false;
    }
  }

  getLogId(log: RemoteLogEntry): string {
    return `${log.timestamp}-${log.message.substring(0, 20)}`.replace(/\s+/g, '-');
  }

  isExpanded(log: RemoteLogEntry): boolean {
    return this.expandedLogs.has(this.getLogId(log));
  }

  toggleDetails(log: RemoteLogEntry): void {
    const logId = this.getLogId(log);
    if (this.expandedLogs.has(logId)) {
      this.expandedLogs.delete(logId);
    } else {
      this.expandedLogs.add(logId);
    }
    this.cdRef.detectChanges();
  }

  formatContext(context: LogContext): string {
    try {
      if (context.response) {
        const parsed = JSON.parse(context.response);
        return JSON.stringify(parsed, null, 2);
      }
      return JSON.stringify(context, null, 2);
    } catch (e) {
      return JSON.stringify(context, null, 2);
    }
  }

  copyLog(log: RemoteLogEntry) {
    const text = log.context 
      ? `${log.timestamp} [${log.level.toUpperCase()}] ${log.message}\n${this.formatContext(log.context)}`
      : `${log.timestamp} [${log.level.toUpperCase()}] ${log.message}`;
    
    navigator.clipboard.writeText(text);
    this.snackBar.open('Log copied to clipboard', 'Dismiss', {
      duration: 2000,
    });
  }

  private loadSavedFilters() {
    const savedFilters = localStorage.getItem('logFilters');
    if (savedFilters) {
      const filters = JSON.parse(savedFilters);
      this.selectedLevel = filters.level || '';
      this.selectedRemote = filters.remote || '';
      this.searchText = filters.search || '';
    }
  }

  saveFilters() {
    const filters = {
      level: this.selectedLevel,
      remote: this.selectedRemote,
      search: this.searchText
    };
    localStorage.setItem('logFilters', JSON.stringify(filters));
  }

  // ngAfterViewChecked() {
  //   if (this.autoScroll && this.terminalLogArea) {
  //     this.scrollToBottom();
  //   }
  // }

  scrollToBottom() {
    if (this.terminalLogArea) {
      const el = this.terminalLogArea.nativeElement;
      el.scrollTop = el.scrollHeight;
    }
  }

  scrollToTop() {
    if (this.terminalLogArea) {
      const el = this.terminalLogArea.nativeElement;
      el.scrollTop = 0;
    }
  }

  @HostListener('document:keydown.escape', ['$event'])
  close(event?: KeyboardEvent) {
    this.saveFilters();
    this.dialogRef.close();
  }
}
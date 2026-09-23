import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  output,
  ElementRef,
  viewChild,
  effect,
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { WorkflowLogEntry, WorkflowLogSeverity } from '../../types/workflow.types';
import { computed } from '@angular/core';

@Component({
  selector: 'app-workflow-execution-log',
  imports: [
    CommonModule,
    DatePipe,
    MatIconModule,
    MatButtonModule,
    MatProgressBarModule,
    TranslatePipe,
  ],
  templateUrl: './workflow-execution-log.component.html',
  styleUrl: './workflow-execution-log.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowExecutionLogComponent {
  readonly engineService = inject(WorkflowEngineService);
  readonly stateService = inject(WorkflowStateService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  readonly isCollapsed = signal<boolean>(false);
  readonly activeFilter = signal<'all' | WorkflowLogSeverity>('all');
  readonly closeConsole = output<void>();

  readonly logListContainer = viewChild<ElementRef<HTMLElement>>('logList');

  readonly errorCount = computed(
    () => this.engineService.logs().filter(l => l.severity === 'error').length
  );
  readonly successCount = computed(
    () => this.engineService.logs().filter(l => l.severity === 'success').length
  );
  readonly warnCount = computed(
    () => this.engineService.logs().filter(l => l.severity === 'warn').length
  );

  readonly filteredLogs = computed(() => {
    const filter = this.activeFilter();
    const all = this.engineService.logs();
    if (filter === 'all') return all;
    return all.filter(l => l.severity === filter);
  });

  constructor() {
    // Auto-scroll to bottom on new logs
    effect(() => {
      const logs = this.engineService.logs();
      if (logs.length > 0) {
        setTimeout(() => {
          const el = this.logListContainer()?.nativeElement;
          if (el) el.scrollTop = el.scrollHeight;
        }, 50);
      }
    });
  }

  setFilter(filter: 'all' | WorkflowLogSeverity): void {
    this.activeFilter.set(filter);
  }

  onLogEntryClick(entry: WorkflowLogEntry): void {
    if (entry.nodeId) {
      this.stateService.selectNode(entry.nodeId, false);
    }
  }

  toggleCollapse(): void {
    this.isCollapsed.update(v => !v);
  }

  clearLogs(): void {
    this.engineService.clearLogs();
  }

  async copyLogs(): Promise<void> {
    const text = this.engineService
      .logs()
      .map(
        l =>
          `[${new Date(l.timestamp).toLocaleTimeString()}] [${l.severity.toUpperCase()}] ${l.message}`
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.notificationService.showSuccess(this.translate.instant('flow.workflow.logs.copied'));
    } catch (err) {
      console.error('[WorkflowLog] Failed to copy logs to clipboard:', err);
    }
  }
}

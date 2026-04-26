import { Component, input, output, inject, computed } from '@angular/core';
import cronstrue from 'cronstrue';
import { DatePipe, NgClass } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ScheduledTask } from '@app/types';
import { isLocalPath } from '@app/services';
import { getCronstrueLocale } from 'src/app/services/i18n/cron-locale.mapper';

const TASK_TYPE_META: Record<string, { icon: string; colorClass: string }> = {
  sync: { icon: 'refresh', colorClass: 'sync-color' },
  copy: { icon: 'copy', colorClass: 'copy-color' },
  move: { icon: 'move', colorClass: 'move-color' },
  bisync: { icon: 'right-left', colorClass: 'bisync-color' },
};

const STATUS_TOGGLE: Record<string, { icon: string; tooltip: string }> = {
  enabled: { icon: 'pause', tooltip: 'task.toggle.disable' },
  running: { icon: 'pause', tooltip: 'task.toggle.disable' },
  disabled: { icon: 'play', tooltip: 'task.toggle.enable' },
  failed: { icon: 'play', tooltip: 'task.toggle.enable' },
  stopping: { icon: 'stop', tooltip: 'task.toggle.stopping' },
};

const DEFAULT_META = { icon: 'circle-info', colorClass: '' };
const DEFAULT_TOGGLE = { icon: 'help', tooltip: 'task.toggle.enable' };

@Component({
  selector: 'app-scheduled-task-card',
  standalone: true,
  imports: [
    NgClass,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    TranslateModule,
    DatePipe,
  ],
  templateUrl: './scheduled-task-card.component.html',
  styleUrl: './scheduled-task-card.component.scss',
})
export class ScheduledTaskCardComponent {
  private readonly translate = inject(TranslateService);

  task = input.required<ScheduledTask>();
  variant = input<'compact' | 'detailed'>('compact');

  toggled = output<string>();
  openInFiles = output<string>();

  protected readonly taskMeta = computed(
    () => TASK_TYPE_META[this.task().taskType] ?? DEFAULT_META
  );

  /** Icon + tooltip key for the enable/disable toggle button. */
  protected readonly toggleState = computed(
    () => STATUS_TOGGLE[this.task().status] ?? DEFAULT_TOGGLE
  );

  protected readonly nextRunFormatted = computed(() => {
    const task = this.task();
    if (task.status === 'disabled') return this.translate.instant('task.nextRun.disabled');
    if (task.status === 'stopping') return this.translate.instant('task.nextRun.stopping');
    return task.nextRun
      ? new Date(task.nextRun).toLocaleString()
      : this.translate.instant('task.nextRun.notScheduled');
  });

  protected readonly lastRunFormatted = computed(() => {
    const task = this.task();
    return task.lastRun
      ? new Date(task.lastRun).toLocaleString()
      : this.translate.instant('task.lastRun.never');
  });

  protected readonly cronDescription = computed(() => {
    try {
      return cronstrue.toString(this.task().cronExpression, {
        locale: getCronstrueLocale(this.translate.getCurrentLang()),
      });
    } catch {
      return this.task().cronExpression;
    }
  });

  protected readonly taskPaths = computed(() => {
    const { args } = this.task();
    const source = (args['source'] as string) || `${args['remote_name']}:`;
    const dest = (args['dest'] as string) || '';
    return {
      source,
      dest,
      sourceIcon: isLocalPath(source) ? 'folder' : 'folder-open',
      destIcon: isLocalPath(dest) ? 'folder' : 'folder-open',
    };
  });

  onToggle(event: Event): void {
    event.stopPropagation();
    this.toggled.emit(this.task().id);
  }

  onOpenInFiles(path: string, event: Event): void {
    event.stopPropagation();
    this.openInFiles.emit(path);
  }
}

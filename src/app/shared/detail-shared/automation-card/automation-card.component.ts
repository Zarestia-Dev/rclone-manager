import { Component, input, output, inject, computed } from '@angular/core';
import cronstrue from 'cronstrue';
import { DatePipe, NgClass } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Automation } from '@app/types';
import { PathService } from '@app/services';
import { getCronstrueLocale } from 'src/app/services/i18n/cron-locale.mapper';

const AUTOMATION_TYPE_META: Record<string, { icon: string; colorClass: string }> = {
  sync: { icon: 'refresh', colorClass: 'sync-color' },
  copy: { icon: 'copy', colorClass: 'copy-color' },
  move: { icon: 'move', colorClass: 'move-color' },
  bisync: { icon: 'right-left', colorClass: 'bisync-color' },
};

const STATUS_TOGGLE: Record<string, { icon: string; tooltip: string }> = {
  enabled: { icon: 'pause', tooltip: 'automation.toggle.disable' },
  running: { icon: 'pause', tooltip: 'automation.toggle.disable' },
  disabled: { icon: 'play', tooltip: 'automation.toggle.enable' },
  failed: { icon: 'play', tooltip: 'automation.toggle.enable' },
  stopping: { icon: 'stop', tooltip: 'automation.toggle.stopping' },
};

const DEFAULT_META = { icon: 'circle-info', colorClass: '' };
const DEFAULT_TOGGLE = { icon: 'help', tooltip: 'automation.toggle.enable' };

@Component({
  selector: 'app-automation-card',
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
  templateUrl: './automation-card.component.html',
  styleUrl: './automation-card.component.scss',
})
export class AutomationCardComponent {
  private readonly translate = inject(TranslateService);
  private readonly pathService = inject(PathService);

  automation = input.required<Automation>();
  variant = input<'compact' | 'detailed'>('compact');

  toggled = output<string>();
  openInFiles = output<string>();

  protected readonly automationMeta = computed(
    () => AUTOMATION_TYPE_META[this.automation().automationType] ?? DEFAULT_META
  );

  /** Icon + tooltip key for the enable/disable toggle button. */
  protected readonly toggleState = computed(
    () => STATUS_TOGGLE[this.automation().status] ?? DEFAULT_TOGGLE
  );

  protected readonly nextRunFormatted = computed(() => {
    const automation = this.automation();
    if (automation.status === 'disabled')
      return this.translate.instant('automation.nextRun.disabled');
    if (automation.status === 'stopping')
      return this.translate.instant('automation.nextRun.stopping');
    if (automation.watchEnabled && automation.cronExpression === 'realtime') {
      return this.translate.instant('automation.monitoring.watcherActive');
    }
    return automation.nextRun
      ? new Date(automation.nextRun).toLocaleString()
      : this.translate.instant('automation.nextRun.notScheduled');
  });

  protected readonly lastRunFormatted = computed(() => {
    const automation = this.automation();
    return automation.lastRun
      ? new Date(automation.lastRun).toLocaleString()
      : this.translate.instant('automation.lastRun.never');
  });

  protected readonly cronDescription = computed(() => {
    try {
      const cronExpr = this.automation().cronExpression;
      if (cronExpr === 'realtime') {
        return (
          this.translate.instant('automation.monitoring.realtimeSchedule') ||
          'Real-time File Watcher'
        );
      }
      return cronstrue.toString(cronExpr, {
        locale: getCronstrueLocale(this.translate.getCurrentLang()),
      });
    } catch {
      return this.automation().cronExpression;
    }
  });

  protected readonly automationPaths = computed(() => {
    const { args } = this.automation();
    // Normalize: Rust always emits arrays, but guard against plain strings in cached state.
    const srcPaths = Array.isArray(args.srcPaths) ? args.srcPaths : [args.srcPaths].filter(Boolean);
    const dstPaths = Array.isArray(args.dstPaths) ? args.dstPaths : [args.dstPaths].filter(Boolean);

    const mapPathToIcon = (path: string): string => {
      const isLocal = this.pathService.isLocalPath(path);
      const lastSegment = path.split(/[\\/]/).pop() ?? '';
      const isFile = lastSegment.includes('.') && !path.endsWith('/') && !path.endsWith('\\');
      if (isFile) {
        return 'file-lines';
      }
      return isLocal ? 'folder' : 'folder-open';
    };

    const sourcePaths = srcPaths.map(path => ({
      path,
      icon: mapPathToIcon(path),
    }));

    const destPaths = dstPaths.map(path => ({
      path,
      icon: mapPathToIcon(path),
    }));

    return {
      sourcePaths,
      destPaths,
      isMultiSource: srcPaths.length > 1,
      isMultiDest: dstPaths.length > 1,
    };
  });

  onToggle(event: Event): void {
    event.stopPropagation();
    this.toggled.emit(this.automation().id);
  }

  onOpenInFiles(path: string, event: Event): void {
    event.stopPropagation();
    this.openInFiles.emit(path);
  }
}

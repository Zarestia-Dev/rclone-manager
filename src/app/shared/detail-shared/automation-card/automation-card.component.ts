import { Component, input, output, inject, computed, ChangeDetectionStrategy } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Automation, AutomationStatus, OPERATION_REGISTRY } from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { formatCronHumanReadable } from 'src/app/services/i18n/cron-locale.mapper';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { AlertBannerComponent } from '../../components/alert-banner/alert-banner.component';

const OPERATIONS = new Map(OPERATION_REGISTRY.map(op => [op.key, op]));

const ORIGINS = {
  workflow: { label: 'flow.tabs.workflow', icon: 'workflow', badge: 'p-accent' },
  quickrun: { label: 'flow.tabs.quickRun', icon: 'quick-run', badge: 'p-primary' },
  dashboard: { label: 'navigation.dashboard', icon: 'cloud', badge: 'p-dim' },
} as const;

const STATUS_PILL: Record<AutomationStatus, string> = {
  enabled: 'p-primary',
  running: 'p-accent',
  disabled: 'p-dim',
  stopping: 'p-orange',
  failed: 'p-warn',
};

const STATUS_TOGGLE: Record<AutomationStatus, { icon: string; tooltip: string }> = {
  enabled: { icon: 'pause', tooltip: 'automation.toggle.disable' },
  running: { icon: 'pause', tooltip: 'automation.toggle.disable' },
  disabled: { icon: 'play', tooltip: 'automation.toggle.enable' },
  failed: { icon: 'pause', tooltip: 'automation.toggle.disable' },
  stopping: { icon: 'stop', tooltip: 'automation.toggle.stopping' },
};

@Component({
  selector: 'app-automation-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    TranslatePipe,
    CopyToClipboardDirective,
    AlertBannerComponent,
  ],
  templateUrl: './automation-card.component.html',
  styleUrl: './automation-card.component.scss',
})
export class AutomationCardComponent {
  private readonly translate = inject(TranslateService);
  private readonly pathService = inject(PathService);
  private readonly automationService = inject(AutomationService);
  private readonly lang = toSignal(this.translate.onLangChange, { initialValue: null });

  automation = input.required<Automation>();
  variant = input<'compact' | 'detailed'>('compact');

  openInFiles = output<string>();

  protected readonly origin = computed(() => {
    const source = this.automation().args?.source;
    const key = source === 'workflow' || source === 'quickrun' ? source : 'dashboard';
    return { key, ...ORIGINS[key] };
  });

  /** A workflow has no remote, operation type or destination of its own. */
  protected readonly isWorkflow = computed(() => this.origin().key === 'workflow');

  /** Icon and colour of the operation; a workflow has no operation of its own. */
  protected readonly typeMeta = computed(() => {
    const type = this.automation().automationType;
    if (!type) return { icon: 'workflow', color: 'accent' };
    const operation = OPERATIONS.get(type);
    return { icon: operation?.icon ?? 'quick-run', color: operation?.cssClass ?? 'accent' };
  });

  protected readonly typeLabelKey = computed(() => {
    const type = this.automation().automationType;
    return type ? `dashboard.appDetail.${type}` : null;
  });

  protected readonly statusPill = computed(() => STATUS_PILL[this.automation().status]);

  /** Icon + tooltip key for the enable/disable toggle button. */
  protected readonly toggleState = computed(() => STATUS_TOGGLE[this.automation().status]);

  protected readonly canRun = computed(() => {
    const { status } = this.automation();
    return status === 'enabled' || status === 'failed';
  });

  protected readonly canStop = computed(() => this.automation().status === 'running');

  /** Key explaining why there is no next run time, or null when a time is shown. */
  protected readonly nextRunKey = computed(() => {
    const { status, watchEnabled, cronExpression, nextRun } = this.automation();
    if (status === 'disabled') return 'automation.nextRun.disabled';
    if (status === 'stopping') return 'automation.nextRun.stopping';
    if (watchEnabled && !cronExpression) return 'automation.monitoring.watcherActive';
    return nextRun ? null : 'automation.nextRun.notScheduled';
  });

  protected readonly nextRunTime = computed(() => this.formatDate(this.automation().nextRun));
  protected readonly lastRunTime = computed(() => this.formatDate(this.automation().lastRun));

  protected readonly cronDescription = computed(() => {
    this.lang();
    return formatCronHumanReadable(
      this.automation().cronExpression ?? '',
      this.translate.getCurrentLang()
    );
  });

  protected readonly automationPaths = computed(() => {
    const { srcPaths, dstPaths } = this.automation().args;
    const withIcon = (path: string): { path: string; icon: string } => ({
      path,
      icon: this.pathService.isLocalPath(path) ? 'folder' : 'folder-open',
    });
    return {
      sourcePaths: srcPaths.map(withIcon),
      destPaths: dstPaths.map(withIcon),
      isMultiSource: srcPaths.length > 1,
      isMultiDest: dstPaths.length > 1,
    };
  });

  /** The service reports a failure to the user through a notification. */
  onToggle(event: Event): void {
    event.stopPropagation();
    this.automationService.toggleAutomation(this.automation().id).catch(() => undefined);
  }

  onRun(event: Event): void {
    event.stopPropagation();
    this.automationService.runAutomation(this.automation().id).catch(() => undefined);
  }

  onStop(event: Event): void {
    event.stopPropagation();
    this.automationService.stopAutomation(this.automation().id).catch(() => undefined);
  }

  onOpenInFiles(path: string, event: Event): void {
    event.stopPropagation();
    this.openInFiles.emit(path);
  }

  /** Enter or Space on the card itself acts as a click; the buttons inside keep their own. */
  onKeyActivate(event: Event): void {
    const card = event.currentTarget as HTMLElement;
    if (event.target !== card) return;
    event.preventDefault();
    card.click();
  }

  private formatDate(value: string | null): string | null {
    return value ? new Date(value).toLocaleString() : null;
  }
}

import { NgTemplateOutlet } from '@angular/common';
import { HeaderControlsDirective } from '../../directives/header-controls.directive';
import {
  Component,
  input,
  model,
  output,
  inject,
  computed,
  effect,
  signal,
  ChangeDetectionStrategy,
  DestroyRef,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  Automation,
  getOperationDef,
  HasStarter,
  ORIGIN_META,
  PillTone,
  profileOf,
  quickRunIdOf,
} from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { MountManagementService } from 'src/app/services/operations/mount-management.service';
import { ServeManagementService } from 'src/app/services/operations/serve-management.service';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { formatCronHumanReadable } from 'src/app/services/i18n/cron-locale.mapper';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { PillDirective } from '../../directives/pill.directive';

/** A trigger as the card shows it: a coloured pill in the compact card, a row in the detailed one. */
interface TriggerView {
  kind: 'schedule' | 'watch' | 'startup';
  icon: string;
  tone: PillTone;
  /** The pill text. */
  label: string;
}

/** What a mount or a serve of the automation is doing right now. */
type LiveState =
  { kind: 'mount'; mountPoint: string | null } | { kind: 'serve'; address: string | null };

const SECONDS = { minute: 60, hour: 3600, day: 86400 } as const;

@Component({
  selector: 'app-automation-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    HeaderControlsDirective,
    MatCardModule,
    MatExpansionModule,
    MatIconModule,
    TranslatePipe,
    CopyToClipboardDirective,
    PillDirective,
  ],
  templateUrl: './automation-card.component.html',
  styleUrl: './automation-card.component.scss',
})
export class AutomationCardComponent {
  private readonly translate = inject(TranslateService);
  private readonly pathService = inject(PathService);
  private readonly automationService = inject(AutomationService);
  private readonly mountService = inject(MountManagementService);
  private readonly serveService = inject(ServeManagementService);
  private readonly backendTranslation = inject(BackendTranslationService);
  private readonly lang = toSignal(this.translate.onLangChange, { initialValue: null });

  automation = input.required<Automation>();
  variant = input<'compact' | 'detailed'>('compact');
  /** Whether the detailed card's panel is open. */
  expanded = model(false);

  openInFiles = output<string>();

  private readonly now = signal(Date.now());

  /** One formatter per language: building one is costly, and the times are read every second. */
  private readonly relativeFormat = computed(() => {
    this.lang();
    return new Intl.RelativeTimeFormat(this.translate.getCurrentLang() ?? undefined, {
      numeric: 'auto',
    });
  });

  constructor() {
    // Relative times ("in 10 hours") move on by themselves.
    const clock = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(clock));

    // The seconds until a delayed start tick only while one is due.
    effect(onCleanup => {
      const startAt = this.automation().autoStartAt;
      if (!startAt) return;
      const due = Date.parse(startAt);
      this.now.set(Date.now());
      const timer = setInterval(() => {
        this.now.set(Date.now());
        if (Date.now() >= due) clearInterval(timer);
      }, 1000);
      onCleanup(() => clearInterval(timer));
    });
  }

  protected readonly origin = computed(() => {
    const source = this.automation().args?.source;
    const key = source === 'workflow' || source === 'quickrun' ? source : 'dashboard';
    return { key, ...ORIGIN_META[key] };
  });

  /** A workflow has no remote, operation type or destination of its own. */
  protected readonly isWorkflow = computed(() => this.origin().key === 'workflow');

  /** Icon and colour of the operation; a workflow has no operation of its own. */
  protected readonly typeMeta = computed(() => {
    const type = this.automation().automationType;
    if (!type) return { icon: 'workflow', tone: 'accent' as PillTone };
    const operation = getOperationDef(type);
    return { icon: operation?.icon ?? 'quick-run', tone: operation?.tone ?? 'accent' };
  });

  protected readonly typeLabelKey = computed(() => {
    const type = this.automation().automationType;
    return type ? `dashboard.appDetail.${type}` : null;
  });

  /** A mount or a serve keeps running once started: it is no job to run again or to stop. */
  protected readonly isResource = computed(() => {
    const type = this.automation().automationType;
    return type === 'mount' || type === 'serve';
  });

  /** A schedule or a watcher is what pausing the automation stops. */
  protected readonly canPause = computed(() => {
    const { cronExpression, watchEnabled, status } = this.automation();
    return (!!cronExpression || watchEnabled) && status !== 'stopping';
  });

  /** Seconds until the start with the app, while it waits for its delay. */
  protected readonly startsIn = computed(() => {
    const startAt = this.automation().autoStartAt;
    if (!startAt) return null;
    const seconds = Math.ceil((Date.parse(startAt) - this.now()) / 1000);
    return seconds > 0 ? seconds : null;
  });

  /** Starting with the app is its only trigger. */
  protected readonly startsOnlyWithTheApp = computed(() => {
    const { autoStart, cronExpression, watchEnabled } = this.automation();
    return autoStart && !cronExpression && !watchEnabled;
  });

  /** The status worth a pill; an enabled automation that waits for its trigger needs none. */
  protected readonly statusPill = computed((): { key: string; tone: PillTone } | null => {
    const { status } = this.automation();
    switch (status) {
      case 'running':
        return { key: 'automation.status.running', tone: 'accent' };
      case 'failed':
        return { key: 'automation.status.failed', tone: 'warn' };
      case 'disabled':
        return { key: 'automation.status.disabled', tone: 'dim' };
      case 'stopping':
        return { key: 'automation.status.stopping', tone: 'orange' };
      case 'enabled':
        return this.startsIn() ? { key: 'automation.card.waiting', tone: 'yellow' } : null;
    }
  });

  protected readonly cronDescription = computed(() => {
    this.lang();
    return formatCronHumanReadable(
      this.automation().cronExpression ?? '',
      this.translate.getCurrentLang()
    );
  });

  protected readonly triggers = computed((): TriggerView[] => {
    this.lang();
    const { cronExpression, watchEnabled, watchDelay, autoStart, autoStartDelay } =
      this.automation();
    const t = (key: string, params?: object): string => this.translate.instant(key, params);
    const triggers: TriggerView[] = [];
    if (cronExpression) {
      triggers.push({
        kind: 'schedule',
        icon: 'clock',
        tone: 'purple',
        label: this.cronDescription(),
      });
    }
    if (watchEnabled) {
      triggers.push({
        kind: 'watch',
        icon: 'eye',
        tone: 'accent',
        label: t('automation.card.watching', { count: watchDelay }),
      });
    }
    if (autoStart) {
      const startsIn = this.startsIn();
      let label = t('automation.startup.badge');
      if (startsIn) label = t('automation.startup.startsIn', { count: startsIn });
      else if (autoStartDelay > 0)
        label = t('automation.card.startupAfter', { count: autoStartDelay });
      triggers.push({ kind: 'startup', icon: 'bolt', tone: 'yellow', label });
    }
    return triggers;
  });

  /** The one fact the compact card's footer states. */
  protected readonly fact = computed((): string => {
    this.lang();
    const { status, lastRun, nextRun, cronExpression } = this.automation();
    const t = (key: string, time?: string | null): string => this.translate.instant(key, { time });
    if (status === 'running') return t('automation.card.started', this.relative(lastRun));
    if (status === 'failed') return t('automation.card.lastTry', this.relative(lastRun));
    if (this.startsIn()) return t('automation.card.notStarted');
    if (cronExpression && nextRun && status === 'enabled') {
      return t('automation.card.nextRun', this.relative(nextRun));
    }
    if (!lastRun) return t('automation.card.neverRun');
    return t(
      this.startsOnlyWithTheApp() ? 'automation.card.started' : 'automation.card.lastRun',
      this.relative(lastRun)
    );
  });

  protected readonly lastErrorText = computed(() =>
    this.backendTranslation.translateBackendMessage(this.automation().lastError)
  );

  /** The mount or serve this automation started, while it runs. */
  protected readonly live = computed((): LiveState | null => {
    const automation = this.automation();
    const owns = (item: HasStarter, fs: string | undefined): boolean =>
      automation.args.source === 'quickrun'
        ? quickRunIdOf(item) === automation.id
        : profileOf(item) === automation.profileName &&
          this.pathService.getRemoteNameFromFs(fs) === automation.remoteName;
    if (automation.automationType === 'mount') {
      const mount = this.mountService.mountedRemotes().find(m => owns(m, m.fs));
      return { kind: 'mount', mountPoint: mount?.mount_point ?? null };
    }
    if (automation.automationType === 'serve') {
      const serve = this.serveService.runningServes().find(s => owns(s, s.params?.fs));
      return { kind: 'serve', address: serve?.addr ?? null };
    }
    return null;
  });

  protected readonly paths = computed(() => {
    const { srcPaths, dstPaths } = this.automation().args;
    const type = this.automation().automationType;
    const withIcon = (path: string): { path: string; icon: string } => ({
      path,
      // The open button: a local folder or a remote one.
      icon: this.pathService.isLocalPath(path) ? 'folder' : 'folder-open',
    });
    // A label for one source and one for several; a workflow names what it watches either way.
    const labels = this.isWorkflow()
      ? {
          source: 'automation.monitoring.watchedFolder',
          sources: 'automation.monitoring.watchedFolder',
          destination: '',
        }
      : type === 'mount' || type === 'serve'
        ? {
            source: 'flow.workflow.inspector.remote',
            sources: 'flow.workflow.inspector.remote',
            destination: 'modals.jobDetail.fields.mountPoint',
          }
        : {
            source: 'automation.card.source',
            sources: 'automation.card.sources',
            destination: 'automation.card.destination',
          };
    return {
      labels,
      sources: srcPaths.map(withIcon),
      // A serve has an address, not a destination; the live row shows it.
      destinations: type === 'serve' ? [] : dstPaths.map(withIcon),
    };
  });

  protected readonly runs = computed(() => {
    const { runCount, successCount, failureCount, stoppedCount } = this.automation();
    const share = (count: number): number => (runCount > 0 ? (count / runCount) * 100 : 0);
    const parts: { key: string; count: number; tone: PillTone }[] = [
      { key: 'dashboard.generalDetail.successful', count: successCount, tone: 'primary' },
      { key: 'dashboard.generalDetail.failedCount', count: failureCount, tone: 'warn' },
      { key: 'dashboard.generalDetail.stoppedCount', count: stoppedCount, tone: 'orange' },
    ];
    return { total: runCount, parts: parts.map(part => ({ ...part, width: share(part.count) })) };
  });

  protected readonly lastRunText = computed(() => {
    this.lang();
    const lastRun = this.automation().lastRun;
    return lastRun
      ? this.translate.instant('automation.card.lastRun', { time: this.relative(lastRun) })
      : this.translate.instant('automation.card.neverRun');
  });

  protected readonly nextRunRelative = computed(() => {
    this.lang();
    return this.relative(this.automation().nextRun);
  });

  protected readonly lastRunRelative = computed(() => {
    this.lang();
    return this.relative(this.automation().lastRun);
  });

  protected formatDate(value: string | null): string | null {
    return value
      ? new Date(value).toLocaleString(this.translate.getCurrentLang() ?? undefined)
      : null;
  }

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

  /** "in 10 hours", "3 minutes ago", in the app's language. */
  private relative(value: string | null): string | null {
    if (!value) return null;
    // `now` only makes the text move on; a time that just arrived is measured from this moment,
    // so a run that has just ended never reads as one still to come.
    this.now();
    const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
    if (!Number.isFinite(seconds)) return null;
    const format = this.relativeFormat();
    const size = Math.abs(seconds);
    if (size < SECONDS.minute) return format.format(seconds, 'second');
    if (size < SECONDS.hour) return format.format(Math.round(seconds / SECONDS.minute), 'minute');
    if (size < SECONDS.day) return format.format(Math.round(seconds / SECONDS.hour), 'hour');
    return format.format(Math.round(seconds / SECONDS.day), 'day');
  }
}

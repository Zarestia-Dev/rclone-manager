import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { FormControl, FormGroup, FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime, distinctUntilChanged } from 'rxjs';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { getOperationDef } from '@app/types';
import type {
  CronValidationResponse,
  PillTone,
  PrimaryActionType,
  QuickRunInput,
} from '@app/types';
import { PillDirective } from 'src/app/shared/directives/pill.directive';
import { NumberInputComponent } from 'src/app/shared/components/number-input/number-input.component';
import * as pathUtils from 'src/app/shared/utils/path.utils';
import { CopyToClipboardDirective } from 'src/app/shared/directives/copy-to-clipboard.directive';
import { PathFieldComponent } from 'src/app/shared/components/path-field/path-field.component';
import { CronInputComponent } from 'src/app/shared/remote-config/cron-input/cron-input.component';
import { describeCron } from 'src/app/services/i18n/cron-locale.mapper';
import { EscapeCloseDirective } from 'src/app/shared/directives/escape-close.directive';
import { FormatEtaPipe } from 'src/app/shared/pipes/format-eta.pipe';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { NavigationDispatcherService } from 'src/app/services/ui/navigation-dispatcher.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import {
  GuideApplyResult,
  GuideRemote,
  GuideSetupStatus,
  SetupIdentity,
  GuideEnvironment,
  IntentGuideService,
} from 'src/app/services/flow/intent-guide.service';
import {
  ModalService,
  IntentGuideModalOptions,
  IntentGuideResume,
} from 'src/app/services/ui/modal.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import {
  DAILY_CRON,
  DEFAULT_SHARE_PORT,
  DEFAULT_STARTUP_DELAY,
  DEFAULT_WATCH_DELAY,
  EffectTone,
  GUIDE_GOALS,
  GUIDE_QUESTIONS,
  GuideAnswers,
  GuideFacts,
  GuideGoal,
  GuideGoalId,
  GuideNetwork,
  ExistingSetup,
  FLOW_ICON,
  GuideOption,
  GuideQuestionId,
  GuideSchedule,
  GuideDestination,
  GuideDestinationSetting,
  GuideTargets,
  PREVIEW_KINDS,
  PreviewFile,
  PreviewGroup,
  PreviewKind,
  PreviewResult,
  baseName,
  buildPlanQuickRun,
  desktopAppProvider,
  displayFolder,
  displayName,
  filterPreviewFiles,
  findSameSetup,
  fsPath,
  getGoal,
  goalTone,
  hasScheduleStep,
  isValidSharePort,
  nextQuestion,
  planAdvice,
  planDetails,
  portOfAddr,
  planEffects,
  recommendedOption,
  resolvePlan,
  shareUrls,
  sharesWithLogin,
} from 'src/app/shared/utils/intent-guide.util';

type GuideStep = 'goal' | 'question' | 'where' | 'when' | 'review' | 'working' | 'done' | 'setups';

/** A status, not an operation, so these roles are not read from the operation registry. */
const PREVIEW_STYLE: Readonly<Record<PreviewKind, { tone: PillTone; icon: string }>> = {
  delete: { tone: 'warn', icon: 'trash' },
  add: { tone: 'accent', icon: 'plus' },
  replace: { tone: 'orange', icon: 'pen' },
  copy: { tone: 'accent', icon: 'copy' },
  error: { tone: 'warn', icon: 'circle-exclamation' },
  untouched: { tone: 'dim', icon: 'shield' },
};

/** Wait this long after the last key before the folder is measured. */
const MEASURE_PAUSE_MS = 500;

/** Files shown at first, and added by each "show more". */
const PREVIEW_PAGE = 50;

type PreviewState =
  | { readonly state: 'idle' }
  | { readonly state: 'running'; readonly executeId?: string }
  | { readonly state: 'done'; readonly result: PreviewResult }
  | { readonly state: 'failed' };

/** The colour of a setup's state, and `Intl` units for how long ago it last ran. */
const SETUP_TONE: Readonly<Record<GuideSetupStatus['state'], PillTone>> = {
  running: 'accent',
  ok: 'primary',
  failed: 'warn',
  stopped: 'yellow',
  idle: 'dim',
};

/** The folders a setup connects, in the direction the files go. */
function setupPath(setup: ExistingSetup, local: string): string {
  const folder = setup.cloudFolder;
  switch (setup.flow) {
    case 'upload':
      return folder ? `${local} → ${folder}` : local;
    case 'download':
      return folder ? `${folder} → ${local}` : local;
    case 'twoWay':
      return folder ? `${local} ⇄ ${folder}` : local;
    case 'cloudToCloud':
      return folder ? `${folder} → ${setup.target}` : `→ ${setup.target}`;
    case 'share':
      return folder;
    default:
      return folder ? `${folder} → ${local}` : local;
  }
}

/** What the start and stop button says and shows, with the words and icons of the mount and serve cards. */
const SETUP_ACTION = {
  stream: {
    start: { actionKey: 'actions.mount', actionIcon: 'mount' },
    stop: { actionKey: 'dashboard.appDetail.unmount', actionIcon: 'eject' },
  },
  share: {
    start: { actionKey: 'actions.serve', actionIcon: 'serve' },
    stop: { actionKey: 'actions.stop', actionIcon: 'stop' },
  },
  job: {
    start: { actionKey: 'automation.actions.run', actionIcon: 'play' },
    stop: { actionKey: 'actions.stop', actionIcon: 'stop' },
  },
} as const;

/** One thing that starts a setup by itself, as the list shows it. */
interface SetupChip {
  readonly icon: string;
  /** `modals.intentGuide.setups.auto.<key>`, or the text itself when `text` is set. */
  readonly key?: string;
  readonly text?: string;
}

/** A setup with everything the list needs to show it. */
interface SetupRow {
  readonly setup: ExistingSetup;
  readonly status: GuideSetupStatus;
  /** `modals.intentGuide.setups.status.<kind>.<state>`; a mount or a share is up or down. */
  readonly statusKey: string;
  readonly statusTone: PillTone;
  /** `modals.intentGuide.setups.kind.<kind>`: where the setup is kept. */
  readonly kind: 'quickRun' | 'profile';
  readonly when: string;
  readonly icon: string;
  readonly tone: PillTone;
  /** Which folders it connects, as `~/Docs → Backup`; empty when the cloud alone says it all. */
  readonly path: string;
  /** What starts it by itself; a single "manual" entry when nothing does. */
  readonly auto: readonly SetupChip[];
  /** The name of an earlier setup that does exactly the same. */
  readonly sameAs: string | null;
  readonly running: boolean;
  /** The button's label and icon: what a tap does now, in the words and icons of the cards. */
  readonly actionKey: string;
  readonly actionIcon: string;
}

interface SetupGroup {
  readonly remote: GuideRemote;
  readonly rows: readonly SetupRow[];
}

const EFFECT_TONE: Readonly<Record<EffectTone, PillTone | undefined>> = {
  safe: 'primary',
  info: undefined,
  warn: 'warn',
};

/**
 * "What do you want to do?": asks in everyday words, shows what will happen with the user's own
 * numbers, then sets the operation up and starts it.
 */
@Component({
  selector: 'app-intent-guide-modal',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    FormsModule,
    UpperCasePipe,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSlideToggleModule,
    TranslatePipe,
    PillDirective,
    FormatEtaPipe,
    FormatFileSizePipe,
    AlertBannerComponent,
    CronInputComponent,
    NumberInputComponent,
    PathFieldComponent,
    CopyToClipboardDirective,
  ],
  templateUrl: './intent-guide-modal.component.html',
  styleUrls: ['./intent-guide-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IntentGuideModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<IntentGuideModalComponent>);
  readonly data = inject<IntentGuideModalOptions | null>(MAT_DIALOG_DATA, {
    optional: true,
  });
  private readonly guide = inject(IntentGuideService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly navigation = inject(NavigationDispatcherService);
  private readonly quickRunService = inject(QuickRunService);
  private readonly modalService = inject(ModalService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  readonly iconService = inject(IconService);

  readonly goals = GUIDE_GOALS;
  readonly baseNameOf = baseName;
  readonly goalTone = goalTone;
  readonly portOfAddr = portOfAddr;
  readonly sharesWithLogin = sharesWithLogin;
  /** A mount point and a two-way folder are checked for what is already in them. */
  readonly inspectOp = computed(() => {
    const flow = this.plan()?.flow;
    return flow === 'stream' ? 'mount' : flow === 'twoWay' ? 'bisync' : null;
  });
  readonly previewPage = PREVIEW_PAGE;

  // ── Environment ──────────────────────────────────────────────────────────
  readonly env = signal<GuideEnvironment | null>(null);
  readonly isLoading = signal(true);
  readonly loadFailed = signal(false);
  readonly remoteName = signal('');
  readonly remotes = computed(() => this.env()?.remotes ?? []);
  readonly remoteType = computed(
    () => this.remotes().find(r => r.name === this.remoteName())?.type ?? ''
  );
  readonly otherRemotes = computed(() => this.remotes().filter(r => r.name !== this.remoteName()));
  readonly otherRemoteNames = computed(() => this.otherRemotes().map(r => r.name));
  readonly otherRemoteType = computed(
    () => this.remotes().find(r => r.name === this.targetRemote())?.type ?? ''
  );
  /** "Google Drive" when the provider has a desktop app the user may know from Windows. */
  readonly appBrand = computed(() => desktopAppProvider(this.remoteType()));
  /** The words for the machine that holds the local folder. */
  readonly localPlace = computed(() => {
    const env = this.env();
    if (env?.isServer) return 'server';
    return env?.isAndroid ? 'phone' : 'computer';
  });

  /** Who connects to a share, for the review's picture: icon and `modals.intentGuide.places.<key>`. */
  readonly sharePlace = computed(() => {
    switch (this.plan()?.serveType) {
      case 'dlna':
        return { icon: 'tv', key: 'tv' };
      case 'http':
        return { icon: 'globe', key: 'browser' };
      default:
        return { icon: 'desktop', key: 'device' };
    }
  });

  // ── Answers ──────────────────────────────────────────────────────────────
  readonly step = signal<GuideStep>('goal');
  readonly goalId = signal<GuideGoalId | null>(null);
  readonly answers = signal<GuideAnswers>({});
  readonly goal = computed<GuideGoal | null>(() => {
    const id = this.goalId();
    return id ? getGoal(id) : null;
  });
  readonly question = computed<GuideQuestionId | null>(() => {
    const goal = this.goal();
    return goal ? nextQuestion(goal, this.answers()) : null;
  });
  readonly questionOptions = computed<readonly GuideOption[]>(() => {
    const q = this.question();
    return q ? GUIDE_QUESTIONS[q] : [];
  });
  readonly questionNumber = computed(() => {
    const goal = this.goal();
    const q = this.question();
    return goal && q ? goal.questions.indexOf(q) + 1 : 0;
  });
  readonly plan = computed(() => {
    const id = this.goalId();
    return id ? resolvePlan(id, this.answers()) : null;
  });

  // ── Where ────────────────────────────────────────────────────────────────
  readonly localPath = signal('');
  readonly remotePath = signal('');
  /** The two path fields edit these groups, in the shape the operation forms keep. */
  readonly localGroup = new FormGroup({
    type: new FormControl('local'),
    path: new FormControl(''),
    remote: new FormControl(''),
  });
  /** Where a move between clouds goes; its type names the other cloud. */
  readonly targetGroup = new FormGroup({
    type: new FormControl(''),
    path: new FormControl(''),
    remote: new FormControl(''),
  });
  readonly cloudGroup = new FormGroup({
    type: new FormControl('currentRemote'),
    path: new FormControl(''),
    remote: new FormControl(''),
  });
  /** The cloud folder follows the local one until the user chooses it. */
  private remotePathChosen = false;
  readonly targetRemote = signal('');
  readonly targetPath = signal('');
  readonly shareUser = signal('');
  readonly sharePassword = signal('');
  readonly sharePort = signal(DEFAULT_SHARE_PORT);
  /** Devices that connect to a WebDAV share can only look, unless this is turned off. */
  readonly shareReadOnly = signal(true);
  readonly shareName = signal('');
  /** This machine's addresses, for a share; null when they are not known. */
  readonly network = signal<GuideNetwork | null>(null);
  readonly sharePortValid = computed(() => isValidSharePort(this.sharePort()));
  /** Another program already listens on the port; unknown counts as free. */
  readonly sharePortBusy = signal(false);
  /** A free port to offer when the chosen one is taken. */
  readonly freePortSuggestion = signal<number | null>(null);
  private portToken = 0;
  private portTimer: ReturnType<typeof setTimeout> | undefined;
  readonly startOnLogin = signal(true);
  /** Where the result is kept: the settings choose, the review step can change it for this run. */
  readonly destination = signal<GuideDestination>('quick_run');

  // ── The guide's own settings ──────────────────────────────────────────────
  readonly settingsOpen = signal(false);
  readonly afterRemote = signal(true);
  readonly destinationSetting = signal<GuideDestinationSetting>('auto');

  // ── When ─────────────────────────────────────────────────────────────────
  readonly scheduleStartup = signal(false);
  readonly scheduleWatch = signal(false);
  readonly scheduleCronOn = signal(false);
  readonly scheduleCron = signal(DAILY_CRON);
  readonly cronValid = signal(true);
  readonly scheduleWatchDelay = signal(DEFAULT_WATCH_DELAY);
  readonly scheduleStartupDelay = signal(DEFAULT_STARTUP_DELAY);
  readonly scheduleOptions = computed(
    () => this.plan()?.scheduleOptions ?? { startup: false, watch: false, cron: false }
  );
  readonly hasWhen = computed(() => {
    const p = this.plan();
    return !!p && hasScheduleStep(p);
  });
  readonly schedule = computed<GuideSchedule>(() => ({
    startup: this.scheduleStartup(),
    watch: this.scheduleWatch(),
    cron: this.scheduleCronOn() ? this.scheduleCron().trim() || null : null,
    watchDelay: this.scheduleWatchDelay(),
    startupDelay: this.scheduleStartupDelay(),
  }));
  readonly scheduleValid = computed(
    () => !this.scheduleCronOn() || (this.cronValid() && !!this.scheduleCron().trim())
  );
  /** The schedule in words, in the language of the interface. */
  readonly cronText = computed(
    () => describeCron(this.scheduleCron().trim(), this.translate.currentLang()).text
  );
  /** Watching sees the local folder only: a two-way copy needs a schedule for the cloud's side. */
  readonly needsCloudSchedule = computed(
    () => this.plan()?.flow === 'twoWay' && this.scheduleWatch() && !this.scheduleCronOn()
  );
  /** What the review lists: one line per trigger that is on, or that it runs only when started. */
  readonly scheduleLines = computed(() => {
    const p = this.plan();
    const s = this.schedule();
    const lines: { key: string; when?: string }[] = [];
    if (s.watch) lines.push({ key: 'watch' });
    if (s.cron) lines.push({ key: 'cron', when: this.cronText() || s.cron });
    if (s.startup) lines.push({ key: p?.flow === 'stream' ? 'startupMount' : 'startup' });
    return lines.length ? lines : [{ key: 'manual' }];
  });
  readonly homeFolders = signal<string[] | null>(null);
  readonly usesSaf = computed(
    () =>
      this.plan()?.flow === 'stream' &&
      this.guide.presets(this.remoteType()).mount?.['mountType'] === 'saf'
  );
  readonly showsLocal = computed(() => !!this.plan()?.needsLocal && !this.usesSaf());
  /** The one thing worth knowing before choosing the folders: `about.where.<key>`. */
  readonly whereAbout = computed(() => {
    const p = this.plan();
    if (p?.flow === 'stream') return this.usesSaf() ? null : 'stream';
    if (p?.flow === 'twoWay') return 'twoWay';
    return p?.flow === 'upload' && p.operationType === 'sync' ? 'mirror' : null;
  });
  /** The user picks the local folder of a copy, a check and the two-way folder; a mount gets a suggested one. */
  readonly localIsSource = computed(() => {
    const flow = this.plan()?.flow;
    return flow === 'upload' || flow === 'compare' || this.goalId() === 'devices';
  });
  readonly whereValid = computed(() => {
    const p = this.plan();
    if (!p) return false;
    if (this.showsLocal() && !this.localPath().trim()) return false;
    if (p.needsSecondRemote && !this.targetRemote()) return false;
    if (sharesWithLogin(p.serveType)) {
      if (!this.shareUser().trim() || !this.sharePassword()) return false;
      if (!this.sharePortValid() || this.sharePortBusy()) return false;
    }
    return true;
  });

  // ── Facts ────────────────────────────────────────────────────────────────
  readonly cloud = signal<{ used?: number; free?: number }>({});
  readonly localFree = signal<number | undefined>(undefined);
  readonly remoteFolderSize = signal<number | undefined>(undefined);
  readonly localFolderSize = signal<number | undefined>(undefined);
  readonly measuring = signal(0);
  readonly facts = computed<GuideFacts>(() => ({
    cloudUsed: this.cloud().used,
    cloudFree: this.cloud().free,
    localFree: this.localFree() ?? this.env()?.homeFree,
    remoteFolderSize: this.remotePath() ? this.remoteFolderSize() : undefined,
    localFolderSize: this.localFolderSize(),
  }));
  readonly recommended = computed(() => {
    const q = this.question();
    return q ? recommendedOption(q) : undefined;
  });
  readonly advice = computed(() => {
    const p = this.plan();
    return p ? planAdvice(p, this.facts()) : null;
  });
  /** The settings the user would not otherwise see, from the values about to be saved. */
  readonly details = computed(() => {
    const p = this.plan();
    if (!p) return [];
    return planDetails(p, {
      presets: this.guide.presets(this.remoteType()),
      targets: this.targets(),
      network: this.network(),
    });
  });
  /** What to type on the other device: the port rclone reports once the share is running. */
  readonly shareLinks = computed(() => {
    const p = this.plan();
    if (!sharesWithLogin(p?.serveType)) return [];
    const port = portOfAddr(this.result()?.execution?.serveAddr) ?? this.sharePort();
    return shareUrls(this.network(), port);
  });

  readonly effects = computed(() => {
    const p = this.plan();
    return p ? planEffects(p, { shareReadOnly: this.shareReadOnly() }) : [];
  });
  readonly operationLabel = computed(() => {
    const op = this.plan()?.operationType;
    return op ? (getOperationDef(op)?.actionLabel ?? op) : '';
  });
  readonly needsMountPlugin = computed(
    () => this.plan()?.flow === 'stream' && !!this.env()?.mountPluginMissing
  );
  readonly offersStartOnLogin = computed(() => {
    const env = this.env();
    return this.scheduleStartup() && !!env?.canStartOnLogin && !env.startsOnLogin;
  });
  /** The folder inside the cloud as the user knows it (`Photos › 2024`), empty for the whole cloud. */
  readonly cloudFolder = computed(() => displayFolder(this.remotePath()));
  readonly targetFolder = computed(() => displayFolder(this.targetPath()));
  /** Names for sentences: never the `remote:path` form, which only rclone understands. */
  readonly cloudLabel = computed(() => displayName(this.remoteName(), this.cloudFolder()));
  readonly targetLabel = computed(() => displayName(this.targetRemote(), this.targetFolder()));

  /** `modals.intentGuide.review.summary.<key>`: one sentence that says what was set up. */
  readonly summaryKey = computed(() => {
    const p = this.plan();
    if (!p) return '';
    switch (p.flow) {
      case 'upload':
      case 'cloudToCloud':
        return `${p.flow}_${p.operationType}`;
      case 'share':
        return `share_${p.serveType}`;
      case 'stream':
        return this.usesSaf() ? 'streamSaf' : 'stream';
      default:
        return p.flow;
    }
  });
  readonly stepNumber = computed(() => {
    const questions = this.goal()?.questions.length ?? 0;
    switch (this.step()) {
      case 'goal':
        return 1;
      case 'question':
        return 1 + this.questionNumber();
      case 'where':
        return 2 + questions;
      case 'when':
        return 3 + questions;
      default:
        return 3 + questions + (this.hasWhen() ? 1 : 0);
    }
  });
  readonly stepTotal = computed(
    () => 3 + (this.goal()?.questions.length ?? 0) + (this.hasWhen() ? 1 : 0)
  );

  // ── Preview and result ───────────────────────────────────────────────────
  readonly preview = signal<PreviewState>({ state: 'idle' });
  /** The group of files the preview lists, the one with the most to look at first. */
  readonly previewKind = signal<PreviewKind | null>(null);
  readonly previewQuery = signal('');
  readonly previewLimit = signal(PREVIEW_PAGE);
  readonly previewResult = computed(() => {
    const p = this.preview();
    return p.state === 'done' ? p.result : null;
  });
  readonly previewGroup = computed<PreviewGroup | undefined>(() => {
    const kind = this.previewKind();
    return this.previewResult()?.groups.find(group => group.kind === kind);
  });
  /** The files of the chosen group that match the search; the whole list is searched. */
  readonly previewMatches = computed<readonly PreviewFile[]>(() =>
    filterPreviewFiles(this.previewGroup()?.files ?? [], this.previewQuery())
  );
  readonly previewVisible = computed(() => this.previewMatches().slice(0, this.previewLimit()));
  /** A sync that deletes files is the one outcome the user must look at before going on. */
  readonly previewDeletes = computed(
    () => this.previewResult()?.groups.find(group => group.kind === 'delete')?.files.length ?? 0
  );
  readonly previewKinds = PREVIEW_KINDS;
  readonly previewGroups = computed(() => this.previewResult()?.groups.map(g => g.kind) ?? []);
  readonly previewStyle = PREVIEW_STYLE;
  readonly previewJob = computed(() => {
    const p = this.preview();
    return p.state === 'running' && p.executeId ? this.guide.job(p.executeId) : undefined;
  });
  readonly workingExecuteId = signal<string | null>(null);
  readonly workingJob = computed(() => {
    const id = this.workingExecuteId();
    return id ? this.guide.job(id) : undefined;
  });
  readonly result = signal<GuideApplyResult | null>(null);
  readonly applyFailed = signal(false);
  // ── What is already set up ───────────────────────────────────────────────
  readonly setups = signal<ExistingSetup[]>([]);
  readonly removingKey = signal<string | null>(null);
  /** The setup that is being started or stopped. */
  readonly busyKey = signal<string | null>(null);
  readonly setupRows = computed((): SetupRow[] => {
    const lang = this.translate.currentLang();
    const firstOfKind = new Map<string, string>();
    return this.setups().map(setup => {
      const live = setup.flow === 'stream' || setup.flow === 'share';
      const polled = this.guide.setupStatus(setup);
      // A mount or a share is up or it is not; it has no last run to report.
      const status: GuideSetupStatus = live
        ? { state: polled.state === 'running' ? 'running' : 'idle' }
        : polled;
      const sameAs = firstOfKind.get(setup.signature) ?? null;
      firstOfKind.set(setup.signature, sameAs ?? setup.name);
      const { automation } = setup;
      const auto: SetupChip[] = [];
      if (automation.startup) {
        auto.push({
          icon: 'power-off',
          key: setup.flow === 'stream' ? 'startupStream' : live ? 'startupShare' : 'startup',
        });
      }
      if (automation.watch) auto.push({ icon: 'bolt', key: 'watch' });
      if (automation.cron) {
        auto.push({ icon: 'calendar', text: describeCron(automation.cron, lang).text });
      }
      if (!auto.length) auto.push({ icon: 'play', key: 'manual' });
      const kind = setup.flow === 'stream' ? 'stream' : setup.flow === 'share' ? 'share' : 'job';
      return {
        setup,
        status,
        statusKey: `${kind}.${status.state}`,
        // A mount or a share that is up is a good state, like a run that went fine.
        statusTone: live && status.state === 'running' ? 'primary' : SETUP_TONE[status.state],
        kind: setup.kind === 'quick_run' ? 'quickRun' : 'profile',
        when: status.at ? this.timeAgo(status.at) : '',
        icon: FLOW_ICON[setup.flow],
        tone: getOperationDef(setup.operationType)?.tone ?? 'dim',
        path: setupPath(setup, setup.local),
        auto,
        sameAs,
        running: status.state === 'running',
        ...SETUP_ACTION[kind][status.state === 'running' ? 'stop' : 'start'],
      };
    });
  });
  /** The setups of each cloud, in the order of the clouds. */
  readonly setupGroups = computed((): SetupGroup[] => {
    const rows = this.setupRows();
    return this.remotes()
      .map(remote => ({ remote, rows: rows.filter(row => row.setup.remoteName === remote.name) }))
      .filter(group => group.rows.length);
  });
  readonly setupCounts = computed(() => {
    const rows = this.setupRows();
    return {
      running: rows.filter(row => row.status.state === 'running').length,
      failed: rows.filter(row => row.status.state === 'failed').length,
    };
  });
  /** A setup that already does what the review is about to set up. */
  readonly sameSetup = computed(() => {
    const p = this.plan();
    return p && this.step() === 'review' ? findSameSetup(this.setups(), p, this.targets()) : null;
  });

  /** Taking back what was set up: working, gone, or not possible. */
  readonly undoState = signal<'idle' | 'working' | 'removed' | 'failed'>('idle');

  /** Why the first sync stopped, as rclone reported it; null when it did not fail or said nothing. */
  readonly failureReason = computed(() => {
    const id = this.result()?.execution?.executeId;
    if (this.doneKey() !== 'twoWayFailed' || !id) return null;
    return this.guide.job(id)?.error?.trim() || null;
  });

  /** `modals.intentGuide.done.<key>` */
  readonly doneKey = computed(() => {
    const p = this.plan();
    const result = this.result();
    if (!p) return 'started';
    switch (p.flow) {
      case 'stream':
        return this.usesSaf() ? 'streamSaf' : 'stream';
      case 'twoWay':
        return result?.firstRunDone ? 'twoWayReady' : 'twoWayFailed';
      case 'share':
        if (p.serveType === 'dlna') return 'shareDlna';
        if (!this.shareLinks().length) return 'noAddress';
        return p.serveType === 'http' ? 'shareHttp' : 'shareWebdav';
      default:
        return 'started';
    }
  });

  readonly effectTone = (tone: EffectTone): PillTone | undefined => EFFECT_TONE[tone];

  constructor() {
    // The signals follow what the fields hold at once; the measurements wait for a pause in typing.
    const local = this.localGroup.controls.path;
    const cloud = this.cloudGroup.controls.path;
    local.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(path => this.onLocalChanged(path ?? ''));
    local.valueChanges
      .pipe(debounceTime(MEASURE_PAUSE_MS), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe(path => this.measureLocal(path ?? ''));
    cloud.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(path => this.onCloudChanged(path ?? ''));
    this.targetGroup.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.onTargetChanged());
    cloud.valueChanges
      .pipe(debounceTime(MEASURE_PAUSE_MS), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe(path => this.measureRemote(path ?? ''));
  }

  ngOnInit(): void {
    void this.load();
    void this.guide.settings().then(settings => {
      this.afterRemote.set(settings.afterRemote);
      this.destinationSetting.set(settings.setting);
      this.destination.set(settings.destination);
    });
  }

  async load(): Promise<void> {
    this.isLoading.set(true);
    this.loadFailed.set(false);
    try {
      const env = await this.guide.loadEnvironment();
      this.env.set(env);
      const resume = this.data?.resume;
      const wanted = resume?.remoteName ?? this.data?.remoteName;
      const names = env.remotes.map(r => r.name);
      this.selectRemote(wanted && names.includes(wanted) ? wanted : (names[0] ?? ''));
      if (resume && this.remoteName() === resume.remoteName) this.carryOn(resume);
      void this.refreshSetups(names);
    } catch (error) {
      this.loadFailed.set(true);
      this.notifications.showError(error);
    } finally {
      this.isLoading.set(false);
    }
  }

  private async refreshSetups(names = this.remotes().map(r => r.name)): Promise<void> {
    try {
      this.setups.set(await this.guide.loadSetups(names));
    } catch (error) {
      // The list is a convenience; the guide works without it.
      console.debug('[IntentGuide] Could not read the existing setups:', error);
    }
  }

  /** "2 hours ago" in the language of the app. */
  private timeAgo(iso: string): string {
    const diff = Date.parse(iso) - Date.now();
    const minutes = Math.round(diff / 60_000);
    const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
      Math.abs(minutes) < 60
        ? [minutes, 'minute']
        : Math.abs(minutes) < 1440
          ? [Math.round(minutes / 60), 'hour']
          : [Math.round(minutes / 1440), 'day'];
    return new Intl.RelativeTimeFormat(this.translate.currentLang() ?? undefined, {
      numeric: 'auto',
    }).format(value, unit);
  }

  /** The list of what is already set up, with its state read again. */
  openSetups(): void {
    this.step.set('setups');
    void this.refreshSetups();
  }

  showSetup(setup: ExistingSetup): void {
    this.close();
    if (setup.kind === 'quick_run' && setup.id) {
      this.navigation.navigateToQuickRun(setup.id);
      return;
    }
    this.openProfile(setup.remoteName, setup.operationType, setup.name);
  }

  /** The remote's page in the main menu, on the tab of the operation and with the profile open. */
  private openProfile(remoteName: string, op: PrimaryActionType, profile: string): void {
    this.navigation.navigateToRemote(
      remoteName,
      op === 'mount' ? 'mount' : op === 'serve' ? 'serve' : 'operations',
      { operationType: op, name: profile }
    );
  }

  /**
   * Asks in the app's confirmation dialog before something that was set up is taken back, and says
   * so when it is running, because removing it stops it first.
   */
  private confirmRemoval(setup: SetupIdentity): Promise<boolean> {
    const running = this.guide.setupStatus(setup).state === 'running';
    return this.notifications.confirmModal(
      this.translate.instant('modals.intentGuide.undo.title'),
      this.translate.instant(
        running ? 'modals.intentGuide.undo.confirmRunning' : 'modals.intentGuide.undo.confirm',
        { name: setup.name }
      ),
      'modals.intentGuide.setups.remove',
      'common.cancel',
      { icon: 'trash', color: 'warn' }
    );
  }

  /** Starts a setup that is not running and stops one that is. */
  async toggleSetup(row: SetupRow): Promise<void> {
    if (this.busyKey()) return;
    this.busyKey.set(row.setup.key);
    try {
      if (row.running) await this.guide.stopSetup(row.setup);
      else await this.guide.startSetup(row.setup);
    } catch (error) {
      this.notifications.showError(error);
    } finally {
      this.busyKey.set(null);
    }
  }

  async removeSetup(setup: ExistingSetup): Promise<void> {
    if (this.removingKey() || !(await this.confirmRemoval(setup))) return;
    this.removingKey.set(setup.key);
    try {
      await this.guide.undo(
        {
          name: setup.name,
          quickRun: setup.kind === 'quick_run' && setup.id ? { id: setup.id } : undefined,
        },
        setup.remoteName,
        setup.operationType
      );
      await this.refreshSetups();
    } catch (error) {
      this.notifications.showError(error);
    } finally {
      this.removingKey.set(null);
    }
  }

  /** Goes on from the choices of a guide that was closed to add the remote this one opened with. */
  private carryOn(resume: IntentGuideResume): void {
    const goal = getGoal(resume.goal);
    if (nextQuestion(goal, resume.answers) !== null) return;
    this.chooseGoal(goal.id);
    for (const q of goal.questions) this.answer(resume.answers[q] ?? '');
  }

  selectRemote(name: string): void {
    this.remoteName.set(name);
    this.cloud.set({});
    if (!name) return;
    void this.measure(async () => {
      const usage = await this.guide.cloudUsage(name);
      if (this.remoteName() === name) this.cloud.set(usage);
    });
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  chooseGoal(id: GuideGoalId): void {
    this.goalId.set(id);
    this.answers.set({});
    this.preview.set({ state: 'idle' });
    this.step.set('question');
    // A goal without questions goes straight on.
    if (this.question() === null) this.proceed();
  }

  answer(option: string): void {
    const q = this.question();
    if (!q) return;
    this.answers.update(a => ({ ...a, [q]: option }));
    if (this.question() === null) this.proceed();
  }

  /** Every question is answered: browsing opens the file browser, the rest asks where. */
  private proceed(): void {
    if (this.plan()?.flow === 'browse') {
      void this.openInFiles();
      return;
    }
    void this.enterWhere();
  }

  toggleSettings(): void {
    this.settingsOpen.update(open => !open);
  }

  setAfterRemote(value: boolean): void {
    this.afterRemote.set(value);
    void this.guide.saveAfterRemote(value).catch(error => this.notifications.showError(error));
  }

  /** Remembers the choice, and uses it for what the guide sets up from now on. */
  async setDestinationSetting(setting: GuideDestinationSetting): Promise<void> {
    this.destinationSetting.set(setting);
    try {
      await this.guide.saveDestination(setting);
      this.destination.set(await this.guide.resolveDestination(setting));
    } catch (error) {
      this.notifications.showError(error);
    }
  }

  back(): void {
    switch (this.step()) {
      case 'question': {
        const goal = this.goal();
        const answered = goal?.questions.filter(q => this.answers()[q] !== undefined) ?? [];
        if (!answered.length) {
          this.step.set('goal');
          return;
        }
        this.dropAnswer(answered[answered.length - 1]);
        return;
      }
      case 'where': {
        const goal = this.goal();
        const last = goal?.questions[goal.questions.length - 1];
        if (!last) {
          this.step.set('goal');
          return;
        }
        this.dropAnswer(last);
        this.step.set('question');
        return;
      }
      case 'when':
        this.step.set('where');
        return;
      case 'review':
        this.preview.set({ state: 'idle' });
        this.step.set(this.hasWhen() ? 'when' : 'where');
        return;
      default:
        this.step.set('goal');
    }
  }

  private dropAnswer(q: GuideQuestionId): void {
    this.answers.update(a => {
      const next = { ...a };
      delete next[q];
      return next;
    });
  }

  private async enterWhere(): Promise<void> {
    const p = this.plan();
    if (!p) return;
    const remote = this.remoteName();
    this.step.set('where');
    this.remotePathChosen = false;
    this.localGroup.reset({ type: 'local', path: '', remote: '' }, { emitEvent: false });
    this.cloudGroup.reset({ type: 'currentRemote', path: '', remote: '' }, { emitEvent: false });
    this.localPath.set('');
    this.remotePath.set('');
    this.localFree.set(undefined);
    this.localFolderSize.set(undefined);
    this.remoteFolderSize.set(undefined);
    const added = this.data?.resume ? this.data.remoteName : undefined;
    const target =
      this.otherRemotes().find(r => r.name === added)?.name ?? this.otherRemotes()[0]?.name ?? '';
    this.targetGroup.reset(
      { type: target ? `otherRemote:${target}` : '', path: remote, remote: target },
      { emitEvent: false }
    );
    this.targetRemote.set(target);
    this.targetPath.set(remote);
    this.shareUser.set(remote.replace(/[^a-zA-Z0-9_-]/g, '-'));
    this.sharePassword.set('');
    this.sharePort.set(DEFAULT_SHARE_PORT);
    this.checkSharePort(true);
    this.shareReadOnly.set(true);
    this.shareName.set(remote);
    this.network.set(null);
    if (p.flow === 'share') void this.guide.network().then(network => this.network.set(network));
    this.resetSchedule(p.schedule);

    const home = this.env()?.home;
    if (this.localIsSource() && home && this.homeFolders() === null) {
      void this.guide.localFolders(home).then(list => this.homeFolders.set(list));
    }

    if (this.showsLocal() && !this.localIsSource()) {
      const kind = p.flow === 'stream' ? 'mount' : 'bisync';
      const suggested = await this.guide.defaultLocalPath(remote, kind);
      if (suggested && !this.localPath()) this.setLocalPath(suggested);
    }
  }

  // ── Folders ──────────────────────────────────────────────────────────────

  private onTargetChanged(): void {
    const { type, path } = this.targetGroup.getRawValue();
    this.targetRemote.set(pathUtils.getRemoteNameFromValue(type ?? '', this.remoteName()) || '');
    this.targetPath.set(path ?? '');
  }

  /** A folder chosen by the guide itself (a suggestion), written into the field. */
  setLocalPath(path: string): void {
    this.localGroup.controls.path.setValue(path);
  }

  private onLocalChanged(path: string): void {
    this.localPath.set(path);
    this.localFree.set(undefined);
    this.localFolderSize.set(undefined);
    if (!this.remotePathChosen && this.localIsSource()) this.suggestRemotePath(baseName(path));
  }

  private measureLocal(path: string): void {
    if (!path) return;
    void this.measure(async () => {
      const free = await this.guide.localFree(path);
      if (this.localPath() === path) this.localFree.set(free);
    });
    if (this.plan()?.flow === 'upload') {
      void this.measure(async () => {
        const size = await this.guide.folderSize(path);
        if (this.localPath() === path) this.localFolderSize.set(size);
      });
    }
  }

  chooseHomeFolder(name: string): void {
    const home = this.env()?.home;
    if (!home) return;
    const separator = home.includes('\\') && !home.includes('/') ? '\\' : '/';
    this.setLocalPath(`${home.replace(/[\\/]+$/, '')}${separator}${name}`);
  }

  /** The cloud folder the guide proposes: it follows the local one until the user picks their own. */
  private suggestRemotePath(path: string): void {
    this.remotePath.set(path);
    this.cloudGroup.controls.path.setValue(path, { emitEvent: false });
    this.remoteFolderSize.set(undefined);
    this.measureRemote(path);
  }

  setRemotePath(path: string): void {
    this.cloudGroup.controls.path.setValue(path);
  }

  /** The user typed or picked a cloud folder. */
  private onCloudChanged(path: string): void {
    this.remotePathChosen = true;
    this.remotePath.set(path);
    this.remoteFolderSize.set(undefined);
  }

  private measureRemote(path: string): void {
    const flow = this.plan()?.flow;
    if (!path || (flow !== 'download' && flow !== 'twoWay')) return;
    const fs = fsPath(this.remoteName(), path);
    void this.measure(async () => {
      const size = await this.guide.folderSize(fs);
      if (this.remotePath() === path) this.remoteFolderSize.set(size);
    });
  }

  private async measure(task: () => Promise<void>): Promise<void> {
    this.measuring.update(n => n + 1);
    try {
      await task();
    } finally {
      this.measuring.update(n => n - 1);
    }
  }

  // ── Review ───────────────────────────────────────────────────────────────

  /** From the folders to the schedule, or straight to the review when nothing can be scheduled. */
  afterWhere(): void {
    if (!this.whereValid()) return;
    this.preview.set({ state: 'idle' });
    this.step.set(this.hasWhen() ? 'when' : 'review');
  }

  toReview(): void {
    if (!this.scheduleValid()) return;
    this.preview.set({ state: 'idle' });
    this.step.set('review');
  }

  private resetSchedule(schedule: GuideSchedule): void {
    this.scheduleStartup.set(schedule.startup);
    this.scheduleWatch.set(schedule.watch);
    this.scheduleCronOn.set(!!schedule.cron);
    this.scheduleCron.set(schedule.cron ?? DAILY_CRON);
    this.cronValid.set(true);
    this.scheduleWatchDelay.set(schedule.watchDelay);
    this.scheduleStartupDelay.set(schedule.startupDelay);
  }

  /** A delay is whole seconds, zero or more; anything else keeps the value it had. */
  setDelay(target: 'watch' | 'startup', value: unknown): void {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return;
    (target === 'watch' ? this.scheduleWatchDelay : this.scheduleStartupDelay).set(
      Math.floor(seconds)
    );
  }

  /** A port is a whole number; anything else keeps the value it had. */
  setSharePort(value: unknown): void {
    const port = Number(value);
    if (!Number.isFinite(port)) return;
    this.sharePort.set(Math.floor(port));
    this.checkSharePort();
  }

  /**
   * Asks whether the port is free once typing pauses. A port the user typed that is taken gets a
   * warning and a free one to pick; the guide's own default quietly moves to a free port instead.
   */
  private checkSharePort(automatic = false): void {
    clearTimeout(this.portTimer);
    const token = ++this.portToken;
    const port = this.sharePort();
    this.sharePortBusy.set(false);
    this.freePortSuggestion.set(null);
    if (!sharesWithLogin(this.plan()?.serveType) || !isValidSharePort(port)) return;
    this.portTimer = setTimeout(
      async () => {
        const free = await this.guide.portFree(port);
        if (token !== this.portToken || free !== false) return;
        const next = await this.guide.nextFreePort(port + 1);
        if (token !== this.portToken) return;
        if (automatic && next !== null) {
          this.sharePort.set(next);
          return;
        }
        this.sharePortBusy.set(true);
        this.freePortSuggestion.set(next);
      },
      automatic ? 0 : MEASURE_PAUSE_MS
    );
  }

  useFreePort(): void {
    const port = this.freePortSuggestion();
    if (port !== null) this.setSharePort(port);
  }

  toggleCron(): void {
    this.scheduleCronOn.update(on => !on);
  }

  onCronChange(cron: string | null): void {
    this.scheduleCron.set(cron ?? '');
  }

  onCronValidation(result: CronValidationResponse): void {
    this.cronValid.set(result.isValid);
  }

  private targets(): GuideTargets {
    return {
      remoteName: this.remoteName(),
      remotePath: this.remotePath(),
      localPath: this.localPath().trim(),
      targetRemote: this.targetRemote() || undefined,
      targetPath: this.targetPath(),
      shareUser: this.shareUser().trim(),
      sharePassword: this.sharePassword(),
      sharePort: this.sharePort(),
      shareReadOnly: this.shareReadOnly(),
      shareName: this.shareName(),
    };
  }

  private buildInput(): QuickRunInput | null {
    const p = this.plan();
    if (!p) return null;
    const goalTitle = this.translate.instant(`modals.intentGuide.runNames.${p.goal}`, {
      remote: this.remoteName(),
    });
    const name = this.quickRunService.generateUniqueQuickRunName(goalTitle);
    return buildPlanQuickRun(
      p,
      this.targets(),
      name,
      this.guide.presets(this.remoteType()),
      this.schedule()
    );
  }

  async runPreview(): Promise<void> {
    const input = this.buildInput();
    if (!input) return;
    this.preview.set({ state: 'running' });
    try {
      const result = await this.guide.preview(
        input,
        this.translate.instant('modals.intentGuide.preview.runName', { name: input.name }),
        executeId => this.preview.set({ state: 'running', executeId })
      );
      if (this.preview().state === 'running') {
        this.openPreview(result);
      }
    } catch {
      if (this.preview().state === 'running') this.preview.set({ state: 'failed' });
    }
  }

  private openPreview(result: PreviewResult | null): void {
    if (!result) {
      this.preview.set({ state: 'failed' });
      return;
    }
    this.previewKind.set(result.groups[0]?.kind ?? null);
    this.previewQuery.set('');
    this.previewLimit.set(PREVIEW_PAGE);
    this.preview.set({ state: 'done', result });
  }

  selectPreviewKind(kind: PreviewKind): void {
    this.previewKind.set(kind);
    this.previewLimit.set(PREVIEW_PAGE);
  }

  setPreviewQuery(query: string): void {
    this.previewQuery.set(query);
    this.previewLimit.set(PREVIEW_PAGE);
  }

  async cancelPreview(): Promise<void> {
    const p = this.preview();
    this.preview.set({ state: 'idle' });
    if (p.state === 'running' && p.executeId) await this.guide.cancel(p.executeId);
  }

  async apply(): Promise<void> {
    const p = this.plan();
    const input = this.buildInput();
    if (!p || !input) return;
    this.step.set('working');
    this.applyFailed.set(false);
    this.undoState.set('idle');
    this.workingExecuteId.set(null);
    try {
      const result = await this.guide.apply(input, p, {
        destination: this.destination(),
        startOnLogin: this.offersStartOnLogin() && this.startOnLogin(),
        onStarted: id => this.workingExecuteId.set(id),
      });
      this.result.set(result);
      this.applyFailed.set(!result);
      this.step.set(result ? 'done' : 'review');
    } catch (error) {
      this.applyFailed.set(true);
      this.notifications.showError(error);
      this.step.set('review');
    }
  }

  /** Opens the Quick Run editor with everything the guide filled in, for the user who wants more. */
  openAdvanced(): void {
    const input = this.buildInput();
    if (!input) return;
    this.close();
    this.modalService.openQuickRunEditor({
      cloneData: input,
      initialOpType: input.operationType,
      initialRemoteName: input.remoteName,
    });
  }

  // ── Done ─────────────────────────────────────────────────────────────────

  /** The local folder the result lives in, which the file manager can open. */
  readonly openablePath = computed(() => {
    const p = this.plan();
    const env = this.env();
    if (!p || env?.isServer || env?.isAndroid) return null;
    if (p.flow === 'stream')
      return this.result()?.execution?.mountPoint || this.localPath() || null;
    if (p.flow === 'download' || p.flow === 'twoWay') return this.localPath() || null;
    return null;
  });

  async openFolder(): Promise<void> {
    const path = this.openablePath();
    if (path) await this.guide.openFolder(path);
  }

  /** Opens the page the result lives on: its profile in the main menu or its Quick Run. */
  showWhere(): void {
    const result = this.result();
    const p = this.plan();
    if (!result || !p?.operationType) return;
    this.close();
    if (result.destination === 'profile') {
      this.openProfile(this.remoteName(), p.operationType, result.name);
    } else if (result.quickRun) {
      this.navigation.navigateToQuickRun(result.quickRun.id);
    }
  }

  async openInFiles(): Promise<void> {
    const remote = this.remoteName();
    const path = this.plan()?.flow === 'cloudToCloud' ? '' : this.remotePath();
    this.close();
    await this.remoteFacade.openRemoteInFiles(remote, path || undefined);
  }

  /** Stops what the guide set up and deletes it; the user's files are not touched. */
  async undo(): Promise<void> {
    const result = this.result();
    const operationType = this.plan()?.operationType;
    if (!result || !operationType) return;
    const identity: SetupIdentity = {
      kind: result.quickRun ? 'quick_run' : 'profile',
      id: result.quickRun?.id,
      name: result.name,
      remoteName: this.remoteName(),
    };
    if (!(await this.confirmRemoval(identity))) return;
    this.undoState.set('working');
    try {
      await this.guide.undo(result, this.remoteName(), operationType);
      this.undoState.set('removed');
    } catch (error) {
      console.error('[IntentGuide] Could not remove the setup:', error);
      this.undoState.set('failed');
    }
  }

  startOver(): void {
    this.undoState.set('idle');
    this.goalId.set(null);
    this.answers.set({});
    this.result.set(null);
    this.preview.set({ state: 'idle' });
    this.step.set('goal');
  }

  addRemote(): void {
    const goal = this.goalId();
    const resume: IntentGuideResume | undefined =
      goal && this.remotes().length
        ? { remoteName: this.remoteName(), goal, answers: this.answers() }
        : undefined;
    this.close();
    this.modalService.openQuickAddRemote(resume);
  }

  installMountPlugin(): void {
    this.guide.installMountPlugin();
  }

  close(): void {
    this.dialogRef.close();
  }
}

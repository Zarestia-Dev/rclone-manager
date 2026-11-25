import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime, distinctUntilChanged, firstValueFrom, merge } from 'rxjs';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { getOperationDef } from '@app/types';
import type {
  CronValidationResponse,
  PillTone,
  PrimaryActionType,
  QuickRunInput,
} from '@app/types';
import * as pathUtils from 'src/app/shared/utils/path.utils';
import { describeCron } from 'src/app/services/i18n/cron-locale.mapper';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { NavigationHistoryService } from 'src/app/services/ui/navigation-history.service';
import { NavigationDispatcherService } from 'src/app/services/ui/navigation-dispatcher.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import {
  WizardApplyResult,
  SetupIdentity,
  WizardEnvironment,
  WizardService,
} from 'src/app/services/flow/wizard.service';
import { ModalService, WizardModalOptions, WizardResume } from 'src/app/services/ui/modal.service';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import {
  DAILY_CRON,
  DEFAULT_SHARE_PORT,
  DEFAULT_STARTUP_DELAY,
  DEFAULT_WATCH_DELAY,
  EffectTone,
  AUTOMATIC_DRIVE,
  WIZARD_GOALS,
  WIZARD_QUESTIONS,
  WizardAnswers,
  WizardFacts,
  WizardGoal,
  WizardGoalId,
  WizardNetwork,
  ExistingSetup,
  FLOW_DIRECTION,
  FLOW_ICON,
  WizardOption,
  WizardQuestionId,
  WizardSchedule,
  WizardDestination,
  WizardDestinationSetting,
  WizardTargets,
  PreviewKind,
  PreviewResult,
  baseName,
  buildPlanQuickRun,
  desktopAppProvider,
  displayFolder,
  displayName,
  findSameSetup,
  fsPath,
  getGoal,
  hasScheduleStep,
  isDrivePath,
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
} from 'src/app/shared/utils/wizard.util';

type WizardScreen = 'goal' | 'question' | 'where' | 'when' | 'review' | 'working' | 'done';

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

/** Files of the delete list shown before the rest are only counted. */
const PREVIEW_LIST = 50;

type PreviewState =
  | { readonly state: 'idle' }
  | { readonly state: 'running'; readonly executeId?: string }
  | { readonly state: 'done'; readonly result: PreviewResult }
  | { readonly state: 'failed' };

/** The order the review lists effects in: what can lose files, then what is new, then what is safe. */
const EFFECT_RANK: Readonly<Record<EffectTone, number>> = { warn: 0, info: 1, safe: 2 };

const EFFECT_TONE: Readonly<Record<EffectTone, PillTone>> = {
  safe: 'primary',
  info: 'accent',
  warn: 'warn',
};

/**
 * Everything the wizard knows while it is open: the answers, the folders, the schedule, the dry
 * run and the result. The dialog provides it, the steps read and change it.
 */
@Injectable()
export class WizardState {
  private readonly dialogRef = inject(MatDialogRef<unknown>);
  readonly data = inject<WizardModalOptions | null>(MAT_DIALOG_DATA, {
    optional: true,
  });
  private readonly service = inject(WizardService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly navigation = inject(NavigationDispatcherService);
  private readonly quickRunService = inject(QuickRunService);
  private readonly modalService = inject(ModalService);
  private readonly notifications = inject(NotificationService);
  private readonly history = inject(NavigationHistoryService);
  private readonly translate = inject(TranslateService);
  private readonly backendTranslation = inject(BackendTranslationService);

  readonly goals = WIZARD_GOALS;
  /** A mount point and a two-way folder are checked for what is already in them. */
  readonly inspectOp = computed(() => {
    const flow = this.plan()?.flow;
    return flow === 'stream' ? 'mount' : flow === 'twoWay' ? 'bisync' : null;
  });

  /** The wizard opened by itself because a cloud was just added, not because the user asked for it. */
  readonly openedAfterCloud = !!this.data?.remoteName;

  // ── Environment ──────────────────────────────────────────────────────────
  readonly env = signal<WizardEnvironment | null>(null);
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
  /**
   * The words for the machine that holds the local folder: a server is named, anything else is
   * "this device", because it may be a Mac, a PC, a phone or a tablet.
   */
  readonly localPlace = computed(() => (this.env()?.isServer ? 'server' : 'thisDevice'));
  /** The picture of that machine: a phone is not a monitor, and not the mobile data switch. */
  readonly localPlaceIcon = computed(() => {
    const env = this.env();
    return env?.isServer ? 'server' : env?.isAndroid ? 'smartphone' : 'desktop';
  });

  /** Who connects to a share, for the review's picture: icon and `modals.wizard.places.<key>`. */
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
  readonly step = signal<WizardScreen>('goal');
  readonly goalId = signal<WizardGoalId | null>(null);
  readonly answers = signal<WizardAnswers>({});
  readonly goal = computed<WizardGoal | null>(() => {
    const id = this.goalId();
    return id ? getGoal(id) : null;
  });
  readonly question = computed<WizardQuestionId | null>(() => {
    const goal = this.goal();
    return goal ? nextQuestion(goal, this.answers()) : null;
  });
  readonly questionOptions = computed<readonly WizardOption[]>(() => {
    const q = this.question();
    return q ? WIZARD_QUESTIONS[q] : [];
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

  /** The share asks for a user name and a password, and listens on a port the wizard chooses. */
  readonly sharesLogin = computed(() => sharesWithLogin(this.plan()?.serveType));

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
  /** Folders the wizard proposes for the cloud; they are measured after the same pause as typing. */
  private readonly suggestedRemotePath = new Subject<string>();
  /** Told apart so that a slow suggestion of an earlier step does not fill the next one. */
  private whereToken = 0;
  readonly targetRemote = signal('');
  readonly targetPath = signal('');
  readonly shareUser = signal('');
  readonly sharePassword = signal('');
  readonly sharePort = signal(DEFAULT_SHARE_PORT);
  /** Devices that connect to a WebDAV share can only look, unless this is turned off. */
  readonly shareReadOnly = signal(true);
  readonly shareName = signal('');
  /** This machine's addresses, for a share; null when they are not known. */
  readonly network = signal<WizardNetwork | null>(null);
  readonly sharePortValid = computed(() => isValidSharePort(this.sharePort()));
  /** Another program already listens on the port; unknown counts as free. */
  readonly sharePortBusy = signal(false);
  /** A free port to offer when the chosen one is taken. */
  readonly freePortSuggestion = signal<number | null>(null);
  private portToken = 0;
  private portTimer: ReturnType<typeof setTimeout> | undefined;
  readonly startOnLogin = signal(true);
  /** Where the result is kept: the settings choose, the review step can change it for this run. */
  readonly destination = signal<WizardDestination>('quick_run');

  // ── The wizard's own settings ──────────────────────────────────────────────
  readonly settingsOpen = signal(false);
  readonly afterRemote = signal(true);
  readonly destinationSetting = signal<WizardDestinationSetting>('auto');
  readonly showMascot = signal(false);

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
  readonly schedule = computed<WizardSchedule>(() => ({
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
    const lines: { key: string; icon: string; when?: string }[] = [];
    if (s.watch) lines.push({ key: 'watch', icon: 'bolt' });
    if (s.cron) lines.push({ key: 'cron', icon: 'calendar', when: this.cronText() || s.cron });
    if (s.startup) {
      lines.push({ key: p?.flow === 'stream' ? 'startupMount' : 'startup', icon: 'power-off' });
    }
    return lines.length ? lines : [{ key: 'manual', icon: 'play' }];
  });
  readonly homeFolders = signal<string[] | null>(null);
  readonly usesSaf = computed(
    () =>
      this.plan()?.flow === 'stream' &&
      this.service.presets(this.remoteType()).mount?.['mountType'] === 'saf'
  );
  readonly showsLocal = computed(() => !!this.plan()?.needsLocal && !this.usesSaf());
  /** A mount on Windows can go to a drive letter, which is where its cloud is easiest to find. */
  readonly usesDriveLetter = computed(
    () => this.plan()?.flow === 'stream' && !this.usesSaf() && !!this.env()?.canUseDriveLetter
  );
  /** The Windows mount target is a drive (a letter or the automatic one), not a folder. */
  readonly localIsDrive = computed(() => this.usesDriveLetter() && isDrivePath(this.localPath()));
  /** Show it as a network drive, and the name File Explorer gives the drive. */
  readonly mountNetworkMode = new FormControl(false);
  readonly mountVolumeName = new FormControl('');
  /** The local folder for a sentence; the automatic drive has no letter yet. */
  readonly localLabel = computed(() =>
    this.localPath() === AUTOMATIC_DRIVE
      ? this.translate.instant('modals.wizard.places.automaticDrive')
      : this.localPath()
  );
  /** The one thing worth knowing before choosing the folders: `about.where.<key>`. */
  readonly whereAbout = computed(() => {
    const p = this.plan();
    if (p?.flow === 'stream') {
      if (this.usesSaf()) return null;
      return this.usesDriveLetter() ? 'streamWindows' : 'stream';
    }
    if (p?.flow === 'twoWay') return 'twoWay';
    return p?.flow === 'upload' && p.operationType === 'sync' ? 'mirror' : null;
  });
  /** The user picks the local folder of a copy, a check and the two-way folder; a mount gets a suggested one. */
  readonly localIsSource = computed(() => {
    const flow = this.plan()?.flow;
    return flow === 'upload' || flow === 'compare' || this.goalId() === 'devices';
  });
  /** `modals.wizard.where.local.<key>`: what the local folder is for. */
  readonly localWhereKey = computed(() => {
    if (this.goalId() === 'devices') return 'devices';
    return this.usesDriveLetter() ? 'streamWindows' : (this.plan()?.flow ?? '');
  });
  /** The last folder of the local path, to mark the home folder chip it matches. */
  readonly localFolderName = computed(() => baseName(this.localPath()));
  readonly whereValid = computed(() => {
    const p = this.plan();
    if (!p) return false;
    if (this.showsLocal() && !this.localPath().trim()) return false;
    if (p.needsSecondRemote && !this.targetRemote()) return false;
    if (this.sharesLogin()) {
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
  readonly facts = computed<WizardFacts>(() => ({
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
      presets: this.service.presets(this.remoteType()),
      targets: this.targets(),
      network: this.network(),
    });
  });
  /** What to type on the other device: the port rclone reports once the share is running. */
  readonly shareLinks = computed(() => {
    if (!this.sharesLogin()) return [];
    return shareUrls(this.network(), this.servePort());
  });
  /** The port rclone reports once the share is running; until then, the one that was chosen. */
  readonly servePort = computed(
    () => portOfAddr(this.result()?.execution?.serveAddr) ?? this.sharePort()
  );

  /** What it does to the files, the effect that can lose something first; the rest keep their order. */
  readonly effects = computed(() => {
    const p = this.plan();
    if (!p) return [];
    return [...planEffects(p, { shareReadOnly: this.shareReadOnly() })]
      .sort((a, b) => EFFECT_RANK[a.tone] - EFFECT_RANK[b.tone])
      .map(effect => ({ ...effect, tone: EFFECT_TONE[effect.tone] }));
  });
  readonly operationLabel = computed(() => {
    const op = this.plan()?.operationType;
    return op ? (getOperationDef(op)?.actionLabel ?? op) : '';
  });
  /** The warning: a mount is planned and the mount plugin is missing. */
  readonly needsMountPlugin = computed(
    () => this.plan()?.flow === 'stream' && this.service.mountPluginMissing()
  );
  /** The warning stops the wizard unless the user turned the plugin check off. */
  readonly blockedByMountPlugin = computed(
    () => this.needsMountPlugin() && !this.service.mountPluginCheckSkipped()
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

  /** The wording of a mount: into the Files app, to a drive, to a drive Windows names, or a folder. */
  private streamKey(): string {
    if (this.usesSaf()) return 'streamSaf';
    if (!this.localIsDrive()) return 'stream';
    return this.localPath() === AUTOMATIC_DRIVE ? 'streamAutoDrive' : 'streamDrive';
  }

  /** `modals.wizard.review.summary.<key>`: one sentence that says what was set up. */
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
        return this.streamKey();
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

  // ── The back button of the system ────────────────────────────────────────

  /**
   * How many steps the user has gone forward from the first screen. Each one is a history entry,
   * so the back gesture of a phone (or the back button of a mouse) goes one step back instead of
   * closing the whole wizard and losing the answers.
   */
  readonly depth = computed(() => {
    const answered = Object.keys(this.answers()).length;
    const open = this.settingsOpen() ? 1 : 0;
    switch (this.step()) {
      case 'goal':
        return open;
      case 'question':
      case 'where':
        return 1 + answered + open;
      case 'when':
        return 2 + answered + open;
      case 'review':
      case 'working':
        return 2 + answered + (this.hasWhen() ? 1 : 0) + open;
      default:
        return 1 + open;
    }
  });
  private readonly layers: (() => void)[] = [];

  private syncLayers(): void {
    const wanted = this.depth();
    while (this.layers.length < wanted) {
      this.layers.push(this.history.openLayer(() => this.onLayerClosed()));
    }
    while (this.layers.length > wanted) this.layers.pop()?.();
  }

  /** The system took the top history entry away: go back the step it stood for. */
  private onLayerClosed(): void {
    this.layers.pop();
    this.back();
    // Registering a layer while the history restores itself would be too early.
    queueMicrotask(() => this.syncLayers());
  }

  // ── Preview and result ───────────────────────────────────────────────────
  readonly preview = signal<PreviewState>({ state: 'idle' });
  readonly previewResult = computed(() => {
    const p = this.preview();
    return p.state === 'done' ? p.result : null;
  });
  /** Files a sync would delete: the one outcome the user must see before going on. */
  readonly previewDeleted = computed(() => {
    const group = this.previewResult()?.groups.find(g => g.kind === 'delete');
    return group
      ? {
          files: group.files.slice(0, PREVIEW_LIST),
          more: Math.max(group.files.length - PREVIEW_LIST, 0),
        }
      : null;
  });
  readonly previewStyle = PREVIEW_STYLE;
  readonly previewJob = computed(() => {
    const p = this.preview();
    return p.state === 'running' && p.executeId ? this.service.job(p.executeId) : undefined;
  });
  readonly workingExecuteId = signal<string | null>(null);
  readonly workingJob = computed(() => {
    const id = this.workingExecuteId();
    return id ? this.service.job(id) : undefined;
  });
  readonly result = signal<WizardApplyResult | null>(null);
  readonly applyFailed = signal(false);
  // ── What is already set up ───────────────────────────────────────────────
  /** Read to tell the user that a setup already does what the review is about to set up. */
  readonly setups = signal<ExistingSetup[]>([]);
  /** A setup that already does what the review is about to set up. */
  readonly sameSetup = computed(() => {
    const p = this.plan();
    return p && this.step() === 'review' ? findSameSetup(this.setups(), p, this.targets()) : null;
  });

  /** Taking back what was set up: working, gone, or not possible. */
  readonly undoState = signal<'idle' | 'working' | 'removed' | 'failed'>('idle');
  /** Why it could not be taken back, in the words of the app's language; empty when it is not known. */
  readonly undoReason = signal('');

  /** Why the first sync stopped, as rclone reported it; null when it did not fail or said nothing. */
  readonly failureReason = computed(() => {
    const id = this.result()?.execution?.executeId;
    if (this.doneKey() !== 'twoWayFailed' || !id) return null;
    return this.service.job(id)?.error?.trim() || null;
  });

  /** `modals.wizard.done.<key>` */
  readonly doneKey = computed(() => {
    const p = this.plan();
    const result = this.result();
    if (!p) return 'started';
    switch (p.flow) {
      case 'stream':
        return this.streamKey();
      case 'twoWay':
        return result?.firstRunDone ? 'twoWayReady' : 'twoWayFailed';
      case 'compare':
      case 'cloudCompare':
        return 'checkStarted';
      case 'share':
        if (p.serveType === 'dlna') return 'shareDlna';
        if (!this.shareLinks().length) return 'noAddress';
        return p.serveType === 'http' ? 'shareHttp' : 'shareWebdav';
      default:
        return 'started';
    }
  });

  /** The review's picture takes the colour role of its operation, like the cards of the dashboard. */
  readonly operationTone = computed<PillTone>(() => {
    const op = this.plan()?.operationType;
    return (op && getOperationDef(op)?.tone) || 'dim';
  });
  readonly operationIcon = computed(() => {
    const p = this.plan();
    const op = p?.operationType;
    return (op && getOperationDef(op)?.icon) || (p ? FLOW_ICON[p.flow] : 'search');
  });
  /** `modals.wizard.review.flow.<key>`: what the picture shows, in a few words. */
  readonly flowCaption = computed(() => {
    const flow = this.plan()?.flow;
    return flow === 'cloudCompare' ? 'compare' : (flow ?? '');
  });
  /** Which way the review's picture points: one way, both ways, a link (a mount) or none (a check). */
  readonly flowDirection = computed(() => FLOW_DIRECTION[this.plan()?.flow ?? 'browse']);

  constructor() {
    effect(() => {
      this.depth();
      untracked(() => this.syncLayers());
    });
    inject(DestroyRef).onDestroy(() => {
      while (this.layers.length) this.layers.pop()?.();
      clearTimeout(this.portTimer);
    });
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
    // No `distinctUntilChanged`: coming back to the step starts from a blank measurement.
    merge(cloud.valueChanges, this.suggestedRemotePath)
      .pipe(debounceTime(MEASURE_PAUSE_MS), takeUntilDestroyed())
      .subscribe(path => this.measureRemote(path ?? ''));
  }

  init(): void {
    void this.load();
    void this.service.settings().then(settings => {
      this.afterRemote.set(settings.afterRemote);
      this.destinationSetting.set(settings.setting);
      this.destination.set(settings.destination);
      this.showMascot.set(settings.showMascot);
    });
  }

  async load(): Promise<void> {
    this.isLoading.set(true);
    this.loadFailed.set(false);
    try {
      const env = await this.service.loadEnvironment();
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
      this.setups.set(await this.service.loadSetups(names));
    } catch (error) {
      // The list is a convenience; the wizard works without it.
      console.debug('[Wizard] Could not read the existing setups:', error);
    }
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

  /** Asks in the app's confirmation dialog before something that was set up is taken back. */
  private confirmRemoval(setup: SetupIdentity): Promise<boolean> {
    return this.notifications.confirmModal(
      this.translate.instant('modals.wizard.undo.title'),
      this.translate.instant('modals.wizard.undo.confirm', { name: setup.name }),
      'modals.wizard.undo.remove',
      'common.cancel',
      { icon: 'trash', color: 'warn' }
    );
  }

  /** Goes on from the choices of a wizard that was closed to add the remote this one opened with. */
  private carryOn(resume: WizardResume): void {
    const goal = getGoal(resume.goal);
    if (nextQuestion(goal, resume.answers) !== null) return;
    this.chooseGoal(goal.id);
    for (const q of goal.questions) this.answer(resume.answers[q] ?? '');
  }

  selectRemote(name: string): void {
    this.remoteName.set(name);
    this.cloud.set({});
    if (!name) return;
    void (async (): Promise<void> => {
      const usage = await this.service.cloudUsage(name);
      if (this.remoteName() === name) this.cloud.set(usage);
    })();
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  chooseGoal(id: WizardGoalId): void {
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
    void this.service.saveAfterRemote(value).catch(error => this.notifications.showError(error));
  }

  setShowMascot(value: boolean): void {
    this.showMascot.set(value);
    void this.service.saveShowMascot(value).catch(error => this.notifications.showError(error));
  }

  /** Remembers the choice, and uses it for what the wizard sets up from now on. */
  async setDestinationSetting(setting: WizardDestinationSetting): Promise<void> {
    this.destinationSetting.set(setting);
    try {
      await this.service.saveDestination(setting);
      this.destination.set(await this.service.resolveDestination(setting));
    } catch (error) {
      this.notifications.showError(error);
    }
  }

  back(): void {
    if (this.settingsOpen()) {
      this.settingsOpen.set(false);
      return;
    }
    switch (this.step()) {
      case 'working':
        // Nothing to go back to while it saves; the layer the gesture used is put back.
        return;
      case 'done':
        this.startOver();
        return;
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

  private dropAnswer(q: WizardQuestionId): void {
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
    const token = ++this.whereToken;
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
    // A copy goes into a folder named after the cloud it comes from; a check compares what exists.
    const targetFolder = p.flow === 'cloudCompare' ? '' : remote;
    this.targetGroup.reset(
      { type: target ? `otherRemote:${target}` : '', path: targetFolder, remote: target },
      { emitEvent: false }
    );
    this.targetRemote.set(target);
    this.targetPath.set(targetFolder);
    this.shareUser.set(remote.replace(/[^a-zA-Z0-9_-]/g, '-'));
    this.sharePassword.set('');
    this.sharePort.set(DEFAULT_SHARE_PORT);
    this.checkSharePort(true);
    this.shareReadOnly.set(true);
    this.mountNetworkMode.reset(
      this.service.presets(this.remoteType()).mount?.['network_mode'] === true
    );
    this.mountVolumeName.reset('');
    this.shareName.set(remote);
    this.network.set(null);
    if (p.flow === 'share') void this.service.network().then(network => this.network.set(network));
    this.resetSchedule(p.schedule);

    const home = this.env()?.home;
    if (this.localIsSource() && home && this.homeFolders() === null) {
      void this.service.localFolders(home).then(list => this.homeFolders.set(list));
    }

    if (this.showsLocal() && !this.localIsSource()) {
      const kind = p.flow === 'stream' ? 'mount' : 'bisync';
      const suggested = await this.service.defaultLocalPath(remote, kind);
      if (token === this.whereToken && suggested && !this.localPath()) this.setLocalPath(suggested);
    }
  }

  // ── Folders ──────────────────────────────────────────────────────────────

  private onTargetChanged(): void {
    const { type, path } = this.targetGroup.getRawValue();
    this.targetRemote.set(pathUtils.getRemoteNameFromValue(type ?? '', this.remoteName()) || '');
    this.targetPath.set(path ?? '');
  }

  /** A folder chosen by the wizard itself (a suggestion), written into the field. */
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
    // A drive holds the cloud, not files of this device: there is nothing to measure.
    if (!path || (this.usesDriveLetter() && isDrivePath(path))) return;
    void (async (): Promise<void> => {
      const free = await this.service.localFree(path);
      if (this.localPath() === path) this.localFree.set(free);
    })();
    if (this.plan()?.flow === 'upload') {
      void (async (): Promise<void> => {
        const size = await this.service.folderSize(path);
        if (this.localPath() === path) this.localFolderSize.set(size);
      })();
    }
  }

  /** Makes a Windows mount in a new folder inside the folder the user picks. */
  async selectMountParent(): Promise<void> {
    const previous = this.localPath();
    try {
      const selected = await this.service.pickFolder();
      if (!selected || this.localPath() !== previous) return;
      const target = pathUtils.windowsMountFolderTarget(
        selected,
        previous,
        this.remoteName(),
        this.mountVolumeName.value
      );
      if (!target) {
        this.notifications.showWarning(
          this.translate.instant('wizards.appOperation.mountFolderLocalDrive')
        );
        return;
      }
      this.setLocalPath(target);
    } catch (error) {
      // Closing the picker is not a failure.
      console.debug('[Wizard] No mount folder picked:', error);
    }
  }

  chooseHomeFolder(name: string): void {
    const home = this.env()?.home;
    if (!home) return;
    const separator = home.includes('\\') && !home.includes('/') ? '\\' : '/';
    this.setLocalPath(`${home.replace(/[\\/]+$/, '')}${separator}${name}`);
  }

  /** The cloud folder the wizard proposes: it follows the local one until the user picks their own. */
  private suggestRemotePath(path: string): void {
    this.remotePath.set(path);
    this.cloudGroup.controls.path.setValue(path, { emitEvent: false });
    this.remoteFolderSize.set(undefined);
    this.suggestedRemotePath.next(path);
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
    void (async (): Promise<void> => {
      const size = await this.service.folderSize(fs);
      if (this.remotePath() === path) this.remoteFolderSize.set(size);
    })();
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

  private resetSchedule(schedule: WizardSchedule): void {
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
   * warning and a free one to pick; the wizard's own default quietly moves to a free port instead.
   */
  private checkSharePort(automatic = false): void {
    clearTimeout(this.portTimer);
    const token = ++this.portToken;
    const port = this.sharePort();
    this.sharePortBusy.set(false);
    this.freePortSuggestion.set(null);
    if (!this.sharesLogin() || !isValidSharePort(port)) return;
    this.portTimer = setTimeout(
      async () => {
        const free = await this.service.portFree(port);
        if (token !== this.portToken || free !== false) return;
        const next = await this.service.nextFreePort(port + 1);
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

  /** Switches one way to start the operation on or off. */
  toggleSchedule(option: 'watch' | 'cron' | 'startup'): void {
    const flag = {
      watch: this.scheduleWatch,
      cron: this.scheduleCronOn,
      startup: this.scheduleStartup,
    }[option];
    flag.update(on => !on);
  }

  onCronChange(cron: string | null): void {
    this.scheduleCron.set(cron ?? '');
  }

  onCronValidation(result: CronValidationResponse): void {
    this.cronValid.set(result.isValid);
  }

  private targets(): WizardTargets {
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
      mountNetworkMode: this.usesDriveLetter() ? this.mountNetworkMode.value === true : undefined,
      mountVolumeName: this.usesDriveLetter() ? (this.mountVolumeName.value ?? '') : undefined,
    };
  }

  private buildInput(): QuickRunInput | null {
    const p = this.plan();
    if (!p) return null;
    const goalTitle = this.translate.instant(`modals.wizard.runNames.${p.goal}`, {
      remote: this.remoteName(),
    });
    const name = this.quickRunService.generateUniqueQuickRunName(goalTitle);
    return buildPlanQuickRun(
      p,
      this.targets(),
      name,
      this.service.presets(this.remoteType()),
      this.schedule()
    );
  }

  async runPreview(): Promise<void> {
    const input = this.buildInput();
    if (!input) return;
    this.preview.set({ state: 'running' });
    try {
      const result = await this.service.preview(
        input,
        this.translate.instant('modals.wizard.preview.runName', { name: input.name }),
        executeId => this.preview.set({ state: 'running', executeId })
      );
      if (this.preview().state === 'running') {
        this.openPreview(result);
      }
    } catch (error) {
      console.error('[Wizard] The dry run failed:', error);
      if (this.preview().state === 'running') this.preview.set({ state: 'failed' });
    }
  }

  private openPreview(result: PreviewResult | null): void {
    if (!result) {
      this.preview.set({ state: 'failed' });
      return;
    }
    this.preview.set({ state: 'done', result });
  }

  async cancelPreview(): Promise<void> {
    const p = this.preview();
    this.preview.set({ state: 'idle' });
    if (p.state === 'running' && p.executeId) await this.service.cancel(p.executeId);
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
      const result = await this.service.apply(input, p, {
        destination: this.destination(),
        startOnLogin: this.offersStartOnLogin() && this.startOnLogin(),
        onStarted: id => this.workingExecuteId.set(id),
      });
      this.result.set(result);
      this.applyFailed.set(!result);
      this.step.set(result ? 'done' : 'review');
      if (result) void this.refreshSetups();
    } catch (error) {
      this.applyFailed.set(true);
      this.notifications.showError(error);
      this.step.set('review');
    }
  }

  /**
   * Opens the editor where this would be kept, with everything the wizard filled in and nothing
   * saved yet: the remote's profile editor for a profile, the Quick Run editor otherwise.
   */
  async openAdvanced(): Promise<void> {
    const input = this.buildInput();
    if (!input) return;
    if (this.destination() === 'profile') {
      const profile = await this.service.planProfile(input);
      if (profile) {
        this.close();
        this.modalService.openRemoteConfig({
          remoteName: input.remoteName,
          remoteType: this.remoteType(),
          editTarget: input.operationType,
          targetProfile: profile.name,
          initialProfile: {
            type: input.operationType,
            name: profile.name,
            settings: profile.settings,
          },
        });
        return;
      }
    }
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
    if (!p || env?.isServer) return null;
    // A mount in the Files app has no folder of its own: the app opens its documents root.
    if (p.flow === 'stream' && this.usesSaf()) return `saf://${this.remoteName()}`;
    if (env?.isAndroid) return null;
    if (p.flow === 'stream') {
      const folder = this.localPath() === AUTOMATIC_DRIVE ? '' : this.localPath();
      return this.result()?.execution?.mountPoint || folder || null;
    }
    if (p.flow === 'download' || p.flow === 'twoWay') return this.localPath() || null;
    return null;
  });

  async openFolder(): Promise<void> {
    const path = this.openablePath();
    if (path) await this.service.openFolder(path);
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

  /** The cloud and folder the file browser opens on; null where the result is not a place to browse. */
  readonly browseTarget = computed(() => {
    const p = this.plan();
    if (!p) return null;
    switch (p.flow) {
      case 'compare':
      case 'cloudCompare':
        return null;
      case 'cloudToCloud':
        return { remote: this.targetRemote(), path: this.targetPath() };
      default:
        return { remote: this.remoteName(), path: this.remotePath() };
    }
  });

  /** What the cloud button opens, in words: `drive › Docs`; empty where there is nothing to browse. */
  readonly browseLabel = computed(() => {
    const target = this.browseTarget();
    return target ? displayName(target.remote, displayFolder(target.path)) : '';
  });

  /** The action the done screen leads with: the folder, else the run, else where it is kept. */
  readonly doneMain = computed<'folder' | 'run' | 'where'>(() =>
    this.openablePath() ? 'folder' : this.resultJob() ? 'run' : 'where'
  );

  /** The run the wizard started, for flows that run once and have a result to look at. */
  readonly resultJob = computed(() => {
    const id = this.result()?.execution?.executeId;
    const flow = this.plan()?.flow;
    if (!id || flow === 'stream' || flow === 'share') return undefined;
    return this.service.job(id);
  });

  openRun(): void {
    const job = this.resultJob();
    if (!job) return;
    this.close();
    this.modalService.openJobDetail(job);
  }

  async openInFiles(): Promise<void> {
    const target = this.browseTarget();
    if (!target) return;
    // The browser takes a full `remote:path` (a bare folder name reads as a folder on this computer).
    const path = target.path ? fsPath(target.remote, target.path) : undefined;
    if (this.modalService.isDialogStandalone()) {
      // The wizard has a window of its own, and the browser opens in one too.
      await this.remoteFacade.openRemoteInFiles(target.remote, path);
      this.close();
      return;
    }
    // The browser opens once the wizard's history layer is gone, or closing the wizard takes it down.
    const closed = firstValueFrom(this.dialogRef.afterClosed());
    this.close();
    await closed;
    await this.remoteFacade.openRemoteInFiles(target.remote, path);
  }

  /** Stops what the wizard set up and deletes it; the user's files are not touched. */
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
    this.undoReason.set('');
    try {
      await this.service.undo(result, this.remoteName(), operationType);
      this.undoState.set('removed');
      void this.refreshSetups();
    } catch (error) {
      console.error('[Wizard] Could not remove the setup:', error);
      this.undoReason.set(this.backendTranslation.translateBackendMessage(error));
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
    const resume: WizardResume | undefined =
      goal && this.remotes().length
        ? { remoteName: this.remoteName(), goal, answers: this.answers() }
        : undefined;
    this.close();
    this.modalService.openQuickAddRemote(resume);
  }

  installMountPlugin(): void {
    this.service.installMountPlugin();
  }

  close(): void {
    this.dialogRef.close();
  }
}

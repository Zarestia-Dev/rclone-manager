import { APP_CONFIG_DEFAULTS, REMOTE_CONFIG_KEYS, getOperationDef } from '@app/types';
import type {
  CompletedTransfer,
  JobReport,
  PillTone,
  PrimaryActionType,
  QuickRunInput,
} from '@app/types';
import { FILE_REPORT_OPERATIONS, parseReportLine, withFileReport } from './job-report.util';
import { getAppCfg, getRcloneCfg } from './profile-config.util';

// ── Goals and questions ─────────────────────────────────────────────────────
//
// The guide asks what the user wants in their own words, then turns the answers into one rclone
// operation. Nothing here names an rclone term; translations live under `modals.intentGuide`.

export type GuideGoalId =
  'access' | 'backup' | 'devices' | 'download' | 'migrate' | 'share' | 'explore';

export type GuideQuestionId = 'deleted' | 'keepOld' | 'device' | 'explore';

export interface GuideOption {
  readonly id: string;
  readonly icon: string;
}

export interface GuideGoal {
  readonly id: GuideGoalId;
  readonly icon: string;
  /** The operation the goal usually ends in; its colour role colours the card. */
  readonly operation?: PrimaryActionType;
  readonly questions: readonly GuideQuestionId[];
}

export const GUIDE_QUESTIONS: Readonly<Record<GuideQuestionId, readonly GuideOption[]>> = {
  deleted: [
    { id: 'keep', icon: 'shield' },
    { id: 'mirror', icon: 'sync' },
  ],
  keepOld: [
    { id: 'keep', icon: 'copy' },
    { id: 'move', icon: 'move' },
  ],
  device: [
    { id: 'folder', icon: 'folder-open' },
    { id: 'browser', icon: 'globe' },
    { id: 'tv', icon: 'tv' },
  ],
  explore: [
    { id: 'browse', icon: 'folder-open' },
    { id: 'compare', icon: 'check-circle' },
  ],
};

export const GUIDE_GOALS: readonly GuideGoal[] = [
  { id: 'access', icon: 'mount', operation: 'mount', questions: [] },
  { id: 'backup', icon: 'cloud-arrow-up', operation: 'sync', questions: ['deleted'] },
  { id: 'devices', icon: 'bisync', operation: 'bisync', questions: [] },
  { id: 'download', icon: 'download', operation: 'copy', questions: [] },
  { id: 'migrate', icon: 'move', operation: 'move', questions: ['keepOld'] },
  { id: 'share', icon: 'tv', operation: 'serve', questions: ['device'] },
  { id: 'explore', icon: 'search', questions: ['explore'] },
];

/** The colour role of a goal card: the one of its operation, so it matches the dashboard. */
export function goalTone(goal: GuideGoal): PillTone {
  return (goal.operation && getOperationDef(goal.operation)?.tone) || 'dim';
}

export type GuideAnswers = Partial<Record<GuideQuestionId, string>>;

export function getGoal(id: GuideGoalId): GuideGoal {
  const goal = GUIDE_GOALS.find(g => g.id === id);
  if (!goal) throw new Error(`Unknown guide goal: ${id}`);
  return goal;
}

/** The first question of the goal that has no valid answer yet, or null once all are answered. */
export function nextQuestion(goal: GuideGoal, answers: GuideAnswers): GuideQuestionId | null {
  return (
    goal.questions.find(q => !GUIDE_QUESTIONS[q].some(option => option.id === answers[q])) ?? null
  );
}

// ── Plan ────────────────────────────────────────────────────────────────────

/** Which way the files go, which also decides the diagram and the consequence lines. */
export type GuideFlow =
  'stream' | 'upload' | 'download' | 'twoWay' | 'cloudToCloud' | 'share' | 'compare' | 'browse';

/**
 * When an operation runs on its own. The three triggers are independent and can be combined; with
 * none of them it runs only when the user starts it.
 */
export interface GuideSchedule {
  /** Runs each time the app starts (a mount connects). */
  readonly startup: boolean;
  /** Runs when a file in the local folder changes. */
  readonly watch: boolean;
  /** A cron expression, or null for no schedule. */
  readonly cron: string | null;
  /** Seconds to wait after the last change before a watcher runs it. */
  readonly watchDelay: number;
  /** Seconds to wait after the app starts before it runs, for a network that is not up yet. */
  readonly startupDelay: number;
}

export const HOURLY_CRON = '0 * * * *';
export const DAILY_CRON = '0 2 * * *';

export const DEFAULT_WATCH_DELAY = APP_CONFIG_DEFAULTS.watchDelay;
export const DEFAULT_STARTUP_DELAY = APP_CONFIG_DEFAULTS.autoStartDelay;

export const MANUAL_SCHEDULE: GuideSchedule = {
  startup: false,
  watch: false,
  cron: null,
  watchDelay: DEFAULT_WATCH_DELAY,
  startupDelay: DEFAULT_STARTUP_DELAY,
};

/** Which triggers make sense for a plan, so the guide only offers those. */
export interface GuideScheduleOptions {
  readonly startup: boolean;
  readonly watch: boolean;
  readonly cron: boolean;
}

/** What a share is served as: a TV or player (DLNA), a network folder (WebDAV) or a web page. */
export type GuideServeType = 'dlna' | 'webdav' | 'http';

/** A share that asks for a user name and password, and listens on a port the guide chooses. */
export const sharesWithLogin = (serveType: GuideServeType | undefined): boolean =>
  serveType === 'webdav' || serveType === 'http';

export interface GuidePlan {
  readonly goal: GuideGoalId;
  /** Undefined for the file browser, which is not an operation. */
  readonly operationType?: PrimaryActionType;
  readonly flow: GuideFlow;
  /** What the guide starts with; the user can change it on the "when" step. */
  readonly schedule: GuideSchedule;
  readonly scheduleOptions: GuideScheduleOptions;
  readonly serveType?: GuideServeType;
  /** A local folder is part of the operation. */
  readonly needsLocal: boolean;
  /** The operation copies the files of another remote. */
  readonly needsSecondRemote: boolean;
  /** A dry run can show what would change before anything does. */
  readonly canPreview: boolean;
  /** Bisync has no state on its first run and must start with `--resync`. */
  readonly firstRunResync: boolean;
}

const NO_OPTIONS: GuideScheduleOptions = { startup: false, watch: false, cron: false };

/** The triggers each flow offers: a watcher needs a local source, a mount only connects. */
const SCHEDULE_OPTIONS: Readonly<Record<GuideFlow, GuideScheduleOptions>> = {
  stream: { startup: true, watch: false, cron: false },
  upload: { startup: true, watch: true, cron: true },
  twoWay: { startup: true, watch: true, cron: true },
  download: { startup: true, watch: false, cron: true },
  cloudToCloud: NO_OPTIONS,
  share: NO_OPTIONS,
  compare: NO_OPTIONS,
  browse: NO_OPTIONS,
};

/** A whole schedule the plan allows: triggers it does not offer are dropped. */
export function effectiveSchedule(guidePlan: GuidePlan, schedule: GuideSchedule): GuideSchedule {
  const { startup, watch, cron } = guidePlan.scheduleOptions;
  return {
    ...schedule,
    startup: startup && schedule.startup,
    watch: watch && schedule.watch,
    cron: cron ? schedule.cron : null,
  };
}

/** Whether the guide has anything to ask on the "when" step. */
export const hasScheduleStep = (guidePlan: GuidePlan): boolean =>
  Object.values(guidePlan.scheduleOptions).some(Boolean);

const plan = (
  goal: GuideGoalId,
  operationType: PrimaryActionType | undefined,
  flow: GuideFlow,
  schedule: GuideSchedule,
  extra: Partial<GuidePlan> = {}
): GuidePlan => ({
  goal,
  operationType,
  flow,
  schedule,
  scheduleOptions: SCHEDULE_OPTIONS[flow],
  needsLocal: ['stream', 'upload', 'download', 'twoWay', 'compare'].includes(flow),
  needsSecondRemote: flow === 'cloudToCloud',
  canPreview: ['upload', 'download', 'twoWay', 'cloudToCloud'].includes(flow),
  firstRunResync: operationType === 'bisync',
  ...extra,
});

/** Both ways need a watcher for the local side and a schedule for what happens in the cloud. */
const KEEP_IN_STEP: GuideSchedule = { ...MANUAL_SCHEDULE, watch: true, cron: HOURLY_CRON };

const SERVE_TYPE_OF_DEVICE: Readonly<Record<string, GuideServeType>> = {
  folder: 'webdav',
  browser: 'http',
  tv: 'dlna',
};

/** Turns the answers into a plan; null until every question of the goal is answered. */
export function resolvePlan(goalId: GuideGoalId, answers: GuideAnswers): GuidePlan | null {
  const goal = getGoal(goalId);
  if (nextQuestion(goal, answers) !== null) return null;

  switch (goalId) {
    case 'access':
      return plan(goalId, 'mount', 'stream', { ...MANUAL_SCHEDULE, startup: true });
    case 'backup':
      return plan(goalId, answers.deleted === 'mirror' ? 'sync' : 'copy', 'upload', {
        ...MANUAL_SCHEDULE,
        cron: DAILY_CRON,
      });
    case 'devices':
      return plan(goalId, 'bisync', 'twoWay', KEEP_IN_STEP);
    case 'download':
      return plan(goalId, 'copy', 'download', MANUAL_SCHEDULE);
    case 'migrate':
      return plan(
        goalId,
        answers.keepOld === 'move' ? 'move' : 'copy',
        'cloudToCloud',
        MANUAL_SCHEDULE
      );
    case 'share':
      return plan(goalId, 'serve', 'share', MANUAL_SCHEDULE, {
        serveType: SERVE_TYPE_OF_DEVICE[answers.device ?? ''] ?? 'webdav',
      });
    case 'explore':
      return answers.explore === 'compare'
        ? plan(goalId, 'check', 'compare', MANUAL_SCHEDULE)
        : plan(goalId, undefined, 'browse', MANUAL_SCHEDULE);
  }
}

// ── What will happen ────────────────────────────────────────────────────────

export type EffectTone = 'safe' | 'info' | 'warn';

export interface GuideEffect {
  /** `modals.intentGuide.effects.<key>` */
  readonly key: string;
  readonly icon: string;
  readonly tone: EffectTone;
}

const effect = (key: string, icon: string, tone: EffectTone): GuideEffect => ({ key, icon, tone });

/** Plain sentences: what happens to a new file, to a deleted file, and to the other side. */
export function planEffects(
  guidePlan: GuidePlan,
  options: { shareReadOnly?: boolean } = {}
): readonly GuideEffect[] {
  const { flow, operationType, serveType } = guidePlan;
  switch (flow) {
    case 'stream':
      return [
        effect('streamOpen', 'download', 'info'),
        effect('streamSave', 'cloud-arrow-up', 'info'),
        effect('streamDelete', 'trash', 'warn'),
      ];
    case 'upload':
      return operationType === 'sync'
        ? [
            effect('uploadNew', 'cloud-arrow-up', 'info'),
            effect('mirrorDelete', 'trash', 'warn'),
            effect('mirrorExtra', 'trash', 'warn'),
          ]
        : [
            effect('uploadNew', 'cloud-arrow-up', 'info'),
            effect('keepDelete', 'shield', 'safe'),
            effect('uploadCloudChange', 'shield', 'safe'),
          ];
    case 'download':
      return [
        effect('downloadNew', 'download', 'info'),
        effect('downloadKeep', 'shield', 'safe'),
        effect('downloadLocalChange', 'shield', 'safe'),
      ];
    case 'twoWay':
      return [
        effect('twoWayChange', 'bisync', 'info'),
        effect('twoWayDelete', 'trash', 'warn'),
        effect('twoWayConflict', 'copy', 'safe'),
      ];
    case 'cloudToCloud':
      return operationType === 'move'
        ? [effect('migrateCopy', 'copy', 'info'), effect('migrateMove', 'trash', 'warn')]
        : [effect('migrateCopy', 'copy', 'info'), effect('migrateKeep', 'shield', 'safe')];
    case 'share':
      if (serveType === 'http') {
        return [
          effect('sharePassword', 'lock', 'safe'),
          effect('shareBrowse', 'globe', 'info'),
          effect('shareStops', 'power-off', 'info'),
        ];
      }
      return serveType === 'dlna'
        ? [
            effect('shareTv', 'tv', 'info'),
            effect('shareReadOnly', 'shield', 'safe'),
            effect('shareStops', 'power-off', 'info'),
          ]
        : [
            effect('sharePassword', 'lock', 'safe'),
            options.shareReadOnly
              ? effect('shareReadOnly', 'shield', 'safe')
              : effect('shareWrite', 'pen', 'warn'),
            effect('shareStops', 'power-off', 'info'),
          ];
    case 'compare':
      return [effect('compareNothing', 'shield', 'safe'), effect('compareList', 'list', 'info')];
    case 'browse':
      return [effect('browseNothing', 'shield', 'safe')];
  }
}

// ── Real data ───────────────────────────────────────────────────────────────

export interface GuideFacts {
  /** Bytes used on the remote (rclone `about`), when the backend reports it. */
  readonly cloudUsed?: number;
  readonly cloudFree?: number;
  /** Bytes in the chosen remote folder (rclone `size`), when it was measured. */
  readonly remoteFolderSize?: number;
  /** Bytes in the chosen local folder, when it was measured. */
  readonly localFolderSize?: number;
  /** Free bytes on the local disk that receives the files. */
  readonly localFree?: number;
}

export type GuideAdviceKey =
  'tooBigForDisk' | 'tightOnDisk' | 'fitsOnDisk' | 'cloudTooFull' | 'streamSavesSpace';

export interface GuideAdvice {
  /** `modals.intentGuide.advice.<key>` */
  readonly key: GuideAdviceKey;
  readonly tone: EffectTone;
  /** Byte counts, formatted by the view. */
  readonly bytes: Readonly<Record<string, number>>;
}

/** Leave a margin: a disk that is 90% full after the copy is not a good place for it. */
const TIGHT_RATIO = 0.9;

/** The amount the local side has to hold: the chosen folder, or everything the remote holds. */
export function incomingBytes(guidePlan: GuidePlan, facts: GuideFacts): number | undefined {
  if (guidePlan.flow !== 'download' && guidePlan.flow !== 'twoWay') return undefined;
  return facts.remoteFolderSize ?? facts.cloudUsed;
}

/** Advice from measured numbers only. Unknown numbers give no advice; nothing is estimated. */
export function planAdvice(guidePlan: GuidePlan, facts: GuideFacts): GuideAdvice | null {
  if (guidePlan.flow === 'stream') {
    if (facts.cloudUsed === undefined || facts.localFree === undefined) return null;
    return facts.cloudUsed > facts.localFree
      ? {
          key: 'streamSavesSpace',
          tone: 'safe',
          bytes: { cloud: facts.cloudUsed, free: facts.localFree },
        }
      : null;
  }

  const incoming = incomingBytes(guidePlan, facts);
  if (incoming !== undefined && facts.localFree !== undefined) {
    const bytes = { size: incoming, free: facts.localFree };
    if (incoming > facts.localFree) return { key: 'tooBigForDisk', tone: 'warn', bytes };
    if (incoming > facts.localFree * TIGHT_RATIO) {
      return { key: 'tightOnDisk', tone: 'warn', bytes };
    }
    return { key: 'fitsOnDisk', tone: 'safe', bytes };
  }

  if (
    guidePlan.flow === 'upload' &&
    facts.localFolderSize !== undefined &&
    facts.cloudFree !== undefined &&
    facts.localFolderSize > facts.cloudFree
  ) {
    return {
      key: 'cloudTooFull',
      tone: 'warn',
      bytes: { size: facts.localFolderSize, free: facts.cloudFree },
    };
  }
  return null;
}

/** The safer answer of a question, marked as recommended. */
export function recommendedOption(question: GuideQuestionId): string | undefined {
  switch (question) {
    case 'deleted':
    case 'keepOld':
      return 'keep';
    case 'device':
      return 'folder';
    default:
      return undefined;
  }
}

// ── Familiar names ──────────────────────────────────────────────────────────

/** Providers whose own desktop app shows the cloud as a folder, which is what a mount does. */
const DESKTOP_APP_PROVIDERS: Readonly<Record<string, string>> = {
  drive: 'Google Drive',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
  box: 'Box',
  pcloud: 'pCloud',
  mega: 'MEGA',
  protondrive: 'Proton Drive',
  iclouddrive: 'iCloud Drive',
};

/** The brand of a remote type that has a desktop app, for "like the X app on Windows". */
export function desktopAppProvider(remoteType: string | undefined): string | undefined {
  return remoteType ? DESKTOP_APP_PROVIDERS[remoteType.toLowerCase()] : undefined;
}

// ── Building the Quick Run ──────────────────────────────────────────────────

export interface GuideTargets {
  readonly remoteName: string;
  /** Path inside the remote, without the `remote:` prefix; empty for the whole remote. */
  readonly remotePath: string;
  readonly localPath: string;
  /** The other remote of a cloud-to-cloud copy. */
  readonly targetRemote?: string;
  readonly targetPath?: string;
  /** User name and password of a WebDAV share. */
  readonly shareUser?: string;
  readonly sharePassword?: string;
  /** The port a WebDAV share listens on. */
  readonly sharePort?: number;
  /** Devices that connect can look but not change anything. */
  readonly shareReadOnly?: boolean;
  /** The name a TV shows for a DLNA share. */
  readonly shareName?: string;
}

/** OS and provider presets of `RemotePresetsService`, the same ones a new remote gets. */
export interface GuidePresets {
  readonly vfs?: Record<string, unknown>;
  readonly mount?: Record<string, unknown>;
}

export const fsPath = (remoteName: string, path = ''): string =>
  `${remoteName}:${path.replace(/^\/+/, '')}`;

/** rclone's WebDAV default listens on localhost only; a share has to listen on every interface. */
export const DEFAULT_SHARE_PORT = 8080;

/** A port a normal user can bind. Below 1024 needs administrator rights. */
export const isValidSharePort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1024 && port <= 65535;

export const shareAddr = (port: number): string => `:${port}`;

function scheduleConfig(schedule: GuideSchedule): QuickRunInput['config']['app'] {
  const app: QuickRunInput['config']['app'] = {};
  if (schedule.startup) {
    app.autoStart = true;
    if (schedule.startupDelay !== DEFAULT_STARTUP_DELAY) app.autoStartDelay = schedule.startupDelay;
  }
  if (schedule.watch) {
    app.watchEnabled = true;
    if (schedule.watchDelay !== DEFAULT_WATCH_DELAY) app.watchDelay = schedule.watchDelay;
  }
  if (schedule.cron) {
    app.cronEnabled = true;
    app.cronExpression = schedule.cron;
  }
  return app;
}

/**
 * The Quick Run the guide saves, in the shape the Quick Run editor saves: paths at the top of
 * `rclone`, operation options beside them and VFS options under `rclone.vfs`.
 */
export function buildPlanQuickRun(
  guidePlan: GuidePlan,
  targets: GuideTargets,
  name: string,
  presets: GuidePresets = {},
  schedule: GuideSchedule = guidePlan.schedule
): QuickRunInput | null {
  const operationType = guidePlan.operationType;
  if (!operationType) return null;

  const remote = fsPath(targets.remoteName, targets.remotePath);
  const rclone: Record<string, unknown> = {};

  switch (guidePlan.flow) {
    case 'stream': {
      const { mountType, ...mountOptions } = presets.mount ?? {};
      rclone['fs'] = remote;
      rclone['mountPoint'] =
        mountType === 'saf' ? `saf://${targets.remoteName}` : targets.localPath;
      if (typeof mountType === 'string' && mountType !== 'mount') rclone['mountType'] = mountType;
      Object.assign(rclone, mountOptions);
      if (presets.vfs && Object.keys(presets.vfs).length) rclone['vfs'] = { ...presets.vfs };
      break;
    }
    case 'upload':
    case 'compare':
      rclone['srcFs'] = targets.localPath;
      rclone['dstFs'] = remote;
      break;
    case 'download':
      rclone['srcFs'] = remote;
      rclone['dstFs'] = targets.localPath;
      break;
    case 'twoWay':
      rclone['path1'] = targets.localPath;
      rclone['path2'] = remote;
      // Bisync refuses to run without its listings; the first run builds them.
      if (guidePlan.firstRunResync) rclone['resync'] = true;
      break;
    case 'cloudToCloud':
      if (!targets.targetRemote) return null;
      rclone['srcFs'] = remote;
      rclone['dstFs'] = fsPath(targets.targetRemote, targets.targetPath);
      break;
    case 'share':
      rclone['fs'] = remote;
      rclone['type'] = guidePlan.serveType ?? 'webdav';
      if (sharesWithLogin(guidePlan.serveType)) {
        rclone['addr'] = shareAddr(targets.sharePort ?? DEFAULT_SHARE_PORT);
        if (targets.shareUser) rclone['user'] = targets.shareUser;
        if (targets.sharePassword) rclone['pass'] = targets.sharePassword;
        // A web page only lists and downloads, so only a network folder has a writable mode.
        if (guidePlan.serveType === 'webdav' && targets.shareReadOnly) {
          rclone['vfs'] = { read_only: true };
        }
      } else if (targets.shareName?.trim()) {
        rclone['name'] = targets.shareName.trim();
      }
      break;
    case 'browse':
      return null;
  }

  return {
    name,
    operationType,
    remoteName: targets.remoteName,
    config: { app: scheduleConfig(effectiveSchedule(guidePlan, schedule)), rclone },
  };
}

// ── Where the guide keeps what it sets up ──────────────────────────────────

/** A Quick Run lives under Flow; a profile lives on the remote's page in the main menu. */
export type GuideDestination = 'quick_run' | 'profile';

/** What the settings store: a destination, or `auto` to follow the startup view. */
export type GuideDestinationSetting = 'auto' | GuideDestination;

/**
 * The destination the settings ask for. `auto` follows the startup view: the main menu keeps
 * profiles, the other views keep Quick Runs.
 */
export function resolveDestination(setting: unknown, defaultView: unknown): GuideDestination {
  if (setting === 'quick_run' || setting === 'profile') return setting;
  return defaultView === 'flow' || defaultView === 'nautilus' ? 'quick_run' : 'profile';
}

/** `name`, or `name-2`, `name-3` … when the name is taken. */
function uniqueName(name: string, taken: readonly string[]): string {
  let candidate = name;
  for (let n = 2; taken.includes(candidate); n++) candidate = `${name}-${n}`;
  return candidate;
}

export interface GuideProfileSave {
  /** The name of the new profile on the remote. */
  readonly name: string;
  /** What to save with the remote's settings: each map that changed, with the new entry added. */
  readonly settings: Readonly<Record<string, Record<string, unknown>>>;
}

/**
 * The same operation as a profile of the remote, in the shape the profile editor saves: the
 * paths and options in `rclone`, the schedule in `app`, and the VFS options in a VFS profile the
 * profile points to. A name that is taken gets a number, so nothing that exists is replaced.
 * `existing` is what the remote's settings hold now.
 */
export function buildPlanProfile(
  input: QuickRunInput,
  existing: Readonly<Record<string, unknown>> = {}
): GuideProfileSave | null {
  const configKey = (REMOTE_CONFIG_KEYS as Readonly<Record<string, string | undefined>>)[
    input.operationType
  ];
  if (!configKey) return null;
  const mapOf = (key: string): Record<string, unknown> => {
    const value = existing[key];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  };

  const profiles = mapOf(configKey);
  const name = uniqueName(input.name, Object.keys(profiles));
  const { vfs, ...rclone } = input.config.rclone;
  const app = { ...input.config.app };
  delete app.showOnTray;

  const settings: Record<string, Record<string, unknown>> = {};
  if (vfs && typeof vfs === 'object' && Object.keys(vfs).length) {
    const vfsProfiles = mapOf(REMOTE_CONFIG_KEYS.vfs);
    const vfsName = uniqueName(name, Object.keys(vfsProfiles));
    app.vfsProfile = vfsName;
    settings[REMOTE_CONFIG_KEYS.vfs] = { ...vfsProfiles, [vfsName]: vfs };
  }
  settings[configKey] = { ...profiles, [name]: { app, rclone } };
  return { name, settings };
}

/**
 * The same Quick Run as a dry run that starts nothing on its own and stays out of the tray. A
 * sync, copy or move also asks for the combined report, which lists every file with its result.
 */
export function asDryRun(input: QuickRunInput): QuickRunInput {
  return {
    ...input,
    config: {
      app: { showOnTray: false },
      rclone: withFileReport(
        { ...input.config.rclone, dryRun: true },
        FILE_REPORT_OPERATIONS.has(input.operationType)
      ),
    },
  };
}

/** The config to keep once bisync's first run built its listings. */
export function withoutResync(config: QuickRunInput['config']): QuickRunInput['config'] {
  const rclone = { ...config.rclone };
  delete rclone['resync'];
  return { ...config, rclone };
}

// ── Sharing: where to connect ──────────────────────────────────────────────

/** What the guide knows about this machine's place on the network. */
export interface GuideNetwork {
  readonly hostName?: string | null;
  readonly addresses: readonly string[];
  /** The address the app connects to a remote backend with, not one read from the machine. */
  readonly viaBackend?: boolean;
}

/** The port of an address rclone reports (`[::]:8080`, `127.0.0.1:8080`, `:8080`). */
export function portOfAddr(addr: string | undefined): number | undefined {
  const match = addr?.match(/:(\d{1,5})$/);
  if (!match) return undefined;
  const port = Number(match[1]);
  return port > 0 && port <= 65535 ? port : undefined;
}

/**
 * The web addresses a phone or another computer types to reach a network folder or web page: one for each
 * network address of this machine, then its host name. Empty when nothing is known.
 */
export function shareUrls(network: GuideNetwork | null | undefined, port: number): string[] {
  if (!network) return [];
  const hosts = [...network.addresses];
  const name = network.hostName?.trim();
  if (name) hosts.push(name);
  return hosts.map(host => `http://${host.includes(':') ? `[${host}]` : host}:${port}`);
}

/** `localhost`, `127.x.x.x` and `::1`: a name only this machine can use. */
export function isLoopbackHost(host: string): boolean {
  const name = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '::1' || /^127(\.\d{1,3}){3}$/.test(name);
}

// ── Details of the setup ────────────────────────────────────────────────────

export interface GuideDetail {
  /** `modals.intentGuide.details.<key>` */
  readonly key: string;
  readonly icon: string;
  /** The value, shown as written; rows without one say everything in the label. */
  readonly value?: string;
  /** Values for the label's placeholders. */
  readonly params?: Readonly<Record<string, string>>;
  /** Shown in a monospace font, like an address. */
  readonly code?: boolean;
  /** Offers a copy button for the value. */
  readonly copy?: boolean;
}

/** `250G` as `250 GB`; anything else as it is. */
export function humanSize(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const match = String(value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([KMGTP])i?B?$/i);
  return match ? `${match[1]} ${match[2].toUpperCase()}B` : String(value);
}

/** `48h` as `48 h`; anything else as it is. */
export function humanDuration(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const match = String(value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i);
  return match ? `${match[1]} ${match[2].toLowerCase()}` : String(value);
}

export interface GuideDetailsInput {
  readonly presets: GuidePresets;
  readonly targets: GuideTargets;
  readonly network?: GuideNetwork | null;
}

/**
 * The settings the user would otherwise never see: for a mount, how much disk its cache may take
 * and how long a change waits before it is sent; for a share, where to connect and with what.
 * Everything is read from the values that are about to be saved.
 */
export function planDetails(guidePlan: GuidePlan, input: GuideDetailsInput): GuideDetail[] {
  const { presets, targets, network } = input;
  const details: GuideDetail[] = [];

  if (guidePlan.flow === 'stream') {
    const vfs = presets.vfs ?? {};
    if (vfs['vfs_cache_mode'] === 'full') {
      details.push({
        key: 'cache',
        icon: 'hard-drive',
        params: {
          size: humanSize(vfs['vfs_cache_max_size']) ?? '',
          age: humanDuration(vfs['vfs_cache_max_age']) ?? '',
        },
      });
    }
    if (vfs['vfs_write_back'] !== undefined) {
      details.push({
        key: 'writeBack',
        icon: 'cloud-arrow-up',
        params: { time: humanDuration(vfs['vfs_write_back']) ?? '' },
      });
    }
    if (vfs['vfs_cache_min_free_space'] !== undefined) {
      details.push({
        key: 'minFree',
        icon: 'shield',
        params: { size: humanSize(vfs['vfs_cache_min_free_space']) ?? '' },
      });
    }
  }

  if (guidePlan.flow === 'share' && sharesWithLogin(guidePlan.serveType)) {
    const port = targets.sharePort ?? DEFAULT_SHARE_PORT;
    const urls = shareUrls(network, port);
    for (const url of urls.slice(0, 3)) {
      details.push({ key: 'address', icon: 'link', value: url, code: true, copy: true });
    }
    if (!urls.length)
      details.push({ key: 'addressUnknown', icon: 'link', value: `:${port}`, code: true });
    if (network?.viaBackend) details.push({ key: 'addressViaBackend', icon: 'info' });
    details.push({ key: 'port', icon: 'server', value: String(port), code: true });
    if (targets.shareUser) {
      details.push({ key: 'user', icon: 'user', value: targets.shareUser, code: true, copy: true });
    }
    const readOnly = guidePlan.serveType === 'http' || targets.shareReadOnly;
    details.push({ key: readOnly ? 'readOnly' : 'canChange', icon: 'shield' });
  }

  if (guidePlan.flow === 'share' && guidePlan.serveType === 'dlna') {
    const name = targets.shareName?.trim();
    if (name) details.push({ key: 'tvName', icon: 'tv', value: name });
  }

  return details;
}

// ── Dry run result ──────────────────────────────────────────────────────────

export interface PreviewCounts {
  readonly transfers: number;
  readonly bytes: number;
  readonly deletes: number;
  readonly errors: number;
}

/** rclone counts the transfers and deletes a dry run skips like real ones. */
export function previewCounts(stats: {
  transfers?: number;
  bytes?: number;
  deletes?: number;
  errors?: number;
}): PreviewCounts {
  return {
    transfers: stats.transfers ?? 0,
    bytes: stats.bytes ?? 0,
    deletes: stats.deletes ?? 0,
    errors: stats.errors ?? 0,
  };
}

/**
 * What a dry run would do to a file, in the order the guide lists them. `copy` is a file that is
 * copied when rclone did not say whether it is new or changed (a two-way copy).
 */
export type PreviewKind = 'delete' | 'add' | 'replace' | 'copy' | 'error' | 'untouched';

export const PREVIEW_KINDS: readonly PreviewKind[] = [
  'delete',
  'add',
  'replace',
  'copy',
  'error',
  'untouched',
];

export interface PreviewFile {
  readonly path: string;
  /** Bytes, when rclone reported the file among its transfers. */
  readonly size?: number;
}

export interface PreviewGroup {
  readonly kind: PreviewKind;
  readonly files: readonly PreviewFile[];
  readonly bytes: number;
}

export interface PreviewResult {
  readonly counts: PreviewCounts;
  /** Only groups that have files. */
  readonly groups: readonly PreviewGroup[];
  /** Files that are already the same on both sides. */
  readonly matched: number;
  /** The files are listed one by one; false when only the counts are known. */
  readonly fileLevel: boolean;
}

type PreviewStats = Parameters<typeof previewCounts>[0] & {
  completed?: readonly CompletedTransfer[];
};

const toGroup = (kind: PreviewKind, files: PreviewFile[]): PreviewGroup => ({
  kind,
  files,
  bytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0),
});

/**
 * Turns the finished dry run into what the user wants to see. The combined report of a sync, copy
 * or move says what rclone found for every file (`+` only in the source, `*` different, `-` only in
 * the destination, `=` the same, `!` failed); a file only in the destination is deleted by a sync
 * and left alone by a copy or a move. Without a report (a two-way copy) the transfers rclone
 * counted in the dry run are listed instead.
 */
export function buildPreview(
  operationType: PrimaryActionType,
  stats: PreviewStats,
  report: JobReport | null
): PreviewResult {
  const sizes = new Map<string, number>();
  for (const done of stats.completed ?? []) sizes.set(done.name, done.size);
  const file = (path: string): PreviewFile => ({ path, size: sizes.get(path) });
  const counts = previewCounts(stats);

  const combined = report?.combined;
  if (combined) {
    const lists: Record<PreviewKind, PreviewFile[]> = {
      delete: [],
      add: [],
      replace: [],
      copy: [],
      error: [],
      untouched: [],
    };
    let matched = 0;
    for (const line of combined) {
      const { sigil, path } = parseReportLine(line, true);
      if (sigil === '+') lists.add.push(file(path));
      else if (sigil === '*') lists.replace.push(file(path));
      else if (sigil === '-')
        (operationType === 'sync' ? lists.delete : lists.untouched).push(file(path));
      else if (sigil === '=') matched++;
      else if (sigil === '!') lists.error.push(file(path));
    }
    return {
      counts,
      matched,
      fileLevel: true,
      groups: PREVIEW_KINDS.filter(kind => lists[kind].length).map(kind =>
        toGroup(kind, lists[kind])
      ),
    };
  }

  const done = stats.completed ?? [];
  const deleted = done.filter(item => item.what === 'deleting').map(item => file(item.name));
  const copied = done
    .filter(item => item.what !== 'deleting' && !item.checked && !item.error)
    .map(item => file(item.name));
  const failed = done.filter(item => item.error).map(item => file(item.name));
  const groups = [
    deleted.length ? toGroup('delete', deleted) : null,
    copied.length ? toGroup('copy', copied) : null,
    failed.length ? toGroup('error', failed) : null,
  ].filter((group): group is PreviewGroup => !!group);
  return { counts, matched: 0, groups, fileLevel: groups.length > 0 };
}

/** The files of a group that match a search, case-insensitively; all of them for a blank search. */
export function filterPreviewFiles(
  files: readonly PreviewFile[],
  query: string
): readonly PreviewFile[] {
  const needle = query.trim().toLowerCase();
  return needle ? files.filter(file => file.path.toLowerCase().includes(needle)) : files;
}

/** The last path segment, for naming a cloud folder after the local one. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return (parts[parts.length - 1] ?? '').replace(/:$/, '');
}

// ── What is already set up ──────────────────────────────────────────────────

/** `Photos/2024` as `Photos › 2024`; the empty path (the whole cloud) stays empty. */
export const displayFolder = (path: string): string => path.split('/').filter(Boolean).join(' › ');

/** A cloud and a folder in it as a person would say it, never as `remote:path`. */
export const displayName = (remote: string, folder: string): string =>
  folder ? `${remote} › ${folder}` : remote;

/** The operations the guide sets up, which are the ones it can describe again. */
export const GUIDE_OPERATIONS: readonly PrimaryActionType[] = [
  'mount',
  'sync',
  'copy',
  'move',
  'bisync',
  'serve',
  'check',
];

export const FLOW_ICON: Readonly<Record<GuideFlow, string>> = {
  stream: 'mount',
  upload: 'cloud-arrow-up',
  download: 'download',
  twoWay: 'bisync',
  cloudToCloud: 'move',
  share: 'tv',
  compare: 'search',
  browse: 'folder-open',
};

/** The triggers of a saved setup, as its app settings hold them. */
export interface SetupAutomation {
  readonly startup: boolean;
  readonly watch: boolean;
  /** The cron expression when a schedule is on. */
  readonly cron: string | null;
}

/** A saved Quick Run or profile, read back into the words of the guide. */
export interface ExistingSetup {
  /** Unique among setups: `quick_run:<id>` or `profile:<remote>:<operation>:<name>`. */
  readonly key: string;
  readonly kind: 'quick_run' | 'profile';
  readonly name: string;
  /** The Quick Run id; absent for a profile. */
  readonly id?: string;
  readonly remoteName: string;
  readonly operationType: PrimaryActionType;
  readonly flow: GuideFlow;
  /** `modals.intentGuide.setups.headline.<key>` */
  readonly summaryKey: string;
  /** What a share is served as (`ftp`, `webdav`…); empty for anything else. */
  readonly serveType: string;
  readonly local: string;
  /** The cloud and its folder, for a sentence. */
  readonly cloud: string;
  /** The folder inside the cloud (`Photos › 2024`); empty for the whole cloud. */
  readonly cloudFolder: string;
  readonly target: string;
  /** The remote a copy between clouds goes to; empty for any other flow. */
  readonly targetRemote: string;
  /** What starts it on its own; all off means it runs only when the user starts it. */
  readonly automation: SetupAutomation;
  /** What the setup does, to tell whether another one would do the same. */
  readonly signature: string;
}

export interface SetupSource {
  readonly kind: 'quick_run' | 'profile';
  readonly name: string;
  readonly id?: string;
  readonly remoteName: string;
  readonly operationType: PrimaryActionType;
  readonly config: unknown;
}

interface CloudSide {
  readonly remote: string;
  readonly path: string;
}

/** The share types the guide offers, which have a headline each; any other is `share_other`. */
const SHARE_TYPES: ReadonlySet<string> = new Set<GuideServeType>(['dlna', 'webdav', 'http']);

/** The operations the guide makes for each flow; a setup with another one is not the same setup. */
const GUIDE_MADE: Partial<Record<GuideFlow, readonly PrimaryActionType[]>> = {
  upload: ['sync', 'copy'],
  download: ['copy'],
  cloudToCloud: ['copy', 'move'],
  compare: ['check'],
  twoWay: ['bisync'],
  stream: ['mount'],
  share: ['serve'],
};

/** The remote and folder of a path that points into one of the remotes; null for a local path. */
function cloudSide(value: unknown, remoteNames: readonly string[]): CloudSide | null {
  if (typeof value !== 'string') return null;
  const remote = remoteNames.find(name => value.startsWith(`${name}:`));
  return remote === undefined ? null : { remote, path: value.slice(remote.length + 1) };
}

const trimPath = (path: string): string => path.replace(/[\\/]+$/, '');

/** A folder inside a cloud without the slashes around it, so `/Docs/` and `Docs` are the same. */
const cloudPath = (path: string): string => trimPath(path.replace(/^\/+/, ''));

/** Equal signatures mean two setups would do the same thing to the same folders. */
export function setupSignature(
  flow: GuideFlow,
  parts: { local?: string; remote: string; path?: string; target?: string; kind?: string }
): string {
  const { local = '', remote, path = '', target = '', kind = '' } = parts;
  return [flow, trimPath(local), remote, cloudPath(path), target, kind].join('|');
}

function automationOf(config: unknown): SetupAutomation {
  const app = getAppCfg(config);
  const cron = app?.cronEnabled ? app.cronExpression?.trim() : '';
  return {
    startup: !!app?.autoStart,
    watch: !!app?.watchEnabled,
    cron: cron || null,
  };
}

/**
 * Reads a saved Quick Run or profile back as one of the guide's flows, whoever made it: every
 * sync, copy, move and check between this computer and a cloud, or between two clouds. Only a
 * setup that has no cloud or folder to name gives null.
 */
export function describeSetup(
  source: SetupSource,
  remoteNames: readonly string[]
): ExistingSetup | null {
  const rclone = getRcloneCfg(source.config) as Record<string, unknown> | null;
  if (!rclone) return null;
  const op = source.operationType;
  const side = (value: unknown): CloudSide | null => cloudSide(value, remoteNames);
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');

  let flow: GuideFlow | null = null;
  let summaryKey = '';
  let local = '';
  let cloud: CloudSide | null = null;
  let target: CloudSide | null = null;
  let kind = '';

  if (op === 'mount') {
    cloud = side(rclone['fs']);
    local = text(rclone['mountPoint']);
    if (cloud && local) {
      flow = 'stream';
      summaryKey = local.startsWith('saf://') ? 'streamSaf' : 'stream';
    }
  } else if (op === 'serve') {
    cloud = side(rclone['fs']);
    const type = text(rclone['type']);
    // Shares of any type are listed; only the ones the guide makes have words of their own.
    if (cloud && type) {
      flow = 'share';
      summaryKey = SHARE_TYPES.has(type) ? `share_${type}` : 'share_other';
      kind = type;
    }
  } else if (op === 'bisync') {
    const one = side(rclone['path1']);
    const two = side(rclone['path2']);
    if (one && !two) [cloud, local] = [one, text(rclone['path2'])];
    else if (two && !one) [cloud, local] = [two, text(rclone['path1'])];
    if (cloud && local) {
      flow = 'twoWay';
      summaryKey = 'twoWay';
    }
  } else {
    const src = side(rclone['srcFs']);
    const dst = side(rclone['dstFs']);
    const isTransfer = op === 'sync' || op === 'copy' || op === 'move';
    if (!src && dst && isTransfer) {
      flow = 'upload';
      summaryKey = `upload_${op}`;
      [cloud, local] = [dst, text(rclone['srcFs'])];
    } else if (src && !dst && isTransfer) {
      flow = 'download';
      summaryKey = op === 'copy' ? 'download' : `download_${op}`;
      [cloud, local] = [src, text(rclone['dstFs'])];
    } else if (src && dst && isTransfer) {
      flow = 'cloudToCloud';
      summaryKey = `cloudToCloud_${op}`;
      [cloud, target] = [src, dst];
    } else if (op === 'check' && !src !== !dst) {
      flow = 'compare';
      summaryKey = 'compare';
      [cloud, local] = src ? [src, text(rclone['dstFs'])] : [dst, text(rclone['srcFs'])];
    }
    // The guide only makes some of these. The others are told apart, so that a plan is never
    // reported as already set up because of a setup that does something else with the folders.
    if (flow && !GUIDE_MADE[flow]?.includes(op)) kind = op;
  }

  if (!flow || !cloud) return null;
  if (flow !== 'cloudToCloud' && flow !== 'share' && !local) return null;
  const folder = displayFolder(cloud.path);
  return {
    key:
      source.kind === 'quick_run'
        ? `quick_run:${source.id}`
        : `profile:${source.remoteName}:${op}:${source.name}`,
    kind: source.kind,
    name: source.name,
    id: source.id,
    remoteName: source.remoteName,
    operationType: op,
    flow,
    summaryKey,
    serveType: flow === 'share' ? kind : '',
    local,
    cloud: displayName(cloud.remote, folder),
    cloudFolder: folder,
    target: target ? displayName(target.remote, displayFolder(target.path)) : '',
    targetRemote: target?.remote ?? '',
    automation: automationOf(source.config),
    signature: setupSignature(flow, {
      local,
      remote: cloud.remote,
      path: cloud.path,
      target: target ? `${target.remote}:${cloudPath(target.path)}` : '',
      kind,
    }),
  };
}

/** What a plan would do, in the same terms as `describeSetup`, to find a setup that already does it. */
export function planSignature(guidePlan: GuidePlan, targets: GuideTargets): string | null {
  if (!guidePlan.operationType || guidePlan.flow === 'browse') return null;
  // The target fields are filled for every goal; only a copy between clouds uses them.
  const target =
    guidePlan.needsSecondRemote && targets.targetRemote
      ? `${targets.targetRemote}:${cloudPath(targets.targetPath ?? '')}`
      : '';
  return setupSignature(guidePlan.flow, {
    local: guidePlan.needsLocal ? targets.localPath : '',
    remote: targets.remoteName,
    path: targets.remotePath,
    target,
    kind: guidePlan.serveType ?? '',
  });
}

/** The setup that already does what the plan would, if there is one. */
export function findSameSetup(
  setups: readonly ExistingSetup[],
  guidePlan: GuidePlan,
  targets: GuideTargets
): ExistingSetup | null {
  const signature = planSignature(guidePlan, targets);
  return signature ? (setups.find(s => s.signature === signature) ?? null) : null;
}

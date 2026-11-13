import type { PillTone } from './pill';
import { ALL_PRIMARY_ACTIONS, PrimaryActionType, SYNC_TYPES } from './operations';
import { Remote } from './remotes';
import { OPERATION_REGISTRY } from './operation-registry';
import { Entry, RcConfigOption } from './remote-config';
import { VfsStats, VfsQueueItem } from 'src/app/services/operations/vfs.service';

export type AppTab = 'mount' | 'operations' | 'serve' | 'general';
export const APP_TABS: readonly AppTab[] = ['mount', 'operations', 'serve', 'general'] as const;
export type OperationTab = Exclude<AppTab, 'general'>;

export interface TabItem<T = string> {
  id: T;
  icon: string;
  label: string;
}

export interface ModeConfig {
  icon: string;
  activeTitle: string;
  inactiveTitle: string;
}

export const MODE_CONFIG: Readonly<Record<OperationTab, ModeConfig>> = Object.freeze({
  mount: {
    icon: 'mount',
    activeTitle: 'appOverview.panelTitles.mountedRemotes',
    inactiveTitle: 'appOverview.panelTitles.unmountedRemotes',
  },
  operations: {
    icon: 'operations',
    activeTitle: 'appOverview.panelTitles.activeOperations',
    inactiveTitle: 'appOverview.panelTitles.inactiveRemotes',
  },
  serve: {
    icon: 'satellite-dish',
    activeTitle: 'appOverview.panelTitles.activeServes',
    inactiveTitle: 'appOverview.panelTitles.availableRemotes',
  },
});

export interface ModalSize {
  width: string;
  maxWidth: string;
  minWidth: string;
  height: string;
  maxHeight: string;
  minHeight?: string;
  disableClose?: boolean;
}

export const STANDARD_MODAL_SIZE: Readonly<ModalSize> = Object.freeze({
  width: '90vw',
  maxWidth: '680px',
  minWidth: '362px',
  height: '80vh',
  maxHeight: '800px',
  minHeight: '240px',
  disableClose: true,
});

export const CONFIG_MODAL_SIZE: Readonly<ModalSize> = Object.freeze({
  width: '95vw',
  maxWidth: '1024px',
  minWidth: '362px',
  height: '90vh',
  maxHeight: '860px',
  disableClose: true,
});

export const ABOUT_MODAL_SIZE: Readonly<ModalSize> = Object.freeze({
  width: '362px',
  maxWidth: '362px',
  minWidth: '362px',
  height: '80vh',
  maxHeight: '650px',
  minHeight: '240px',
  disableClose: true,
});

export interface ConfirmDialogData {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  icon?: string;
  color?: 'primary' | 'accent' | 'warn';
}

export type ExportType = 'All' | 'Settings' | 'SpecificRemote' | { Category: string };

export const ExportType = {
  All: 'All' as ExportType,
  Settings: 'Settings' as ExportType,
  SpecificRemote: 'SpecificRemote' as ExportType,
  Category: (name: string): ExportType => ({ Category: name }),
};

export interface ExportModalData {
  remoteName?: string;
  defaultExportType?: ExportType;
}

export interface PasswordPromptResult {
  password: string;
  stored: boolean;
}

export type Theme = 'light' | 'dark' | 'system';

export type ConnectionStatus = 'online' | 'offline' | 'checking';

export type PanelId =
  'remotes' | 'bandwidth' | 'system' | 'jobs' | 'automations' | 'serves' | 'quickRuns';

export interface PanelConfig {
  id: PanelId;
  title: string;
  defaultVisible: boolean;
}

export const SCROLL_DELAY_MS = 60;

export const ALL_PANELS: readonly PanelConfig[] = Object.freeze([
  { id: 'remotes', title: 'generalOverview.panels.remotes', defaultVisible: true },
  { id: 'bandwidth', title: 'generalOverview.panels.bandwidth', defaultVisible: true },
  { id: 'system', title: 'generalOverview.panels.system', defaultVisible: true },
  { id: 'jobs', title: 'generalOverview.panels.jobs', defaultVisible: true },
  { id: 'automations', title: 'generalOverview.panels.automations', defaultVisible: true },
  { id: 'serves', title: 'generalOverview.panels.serves', defaultVisible: true },
]);

export const ALL_QUICK_RUN_PANELS: readonly PanelConfig[] = Object.freeze([
  { id: 'quickRuns', title: 'flow.quickRun.overview.quickLaunch', defaultVisible: true },
  { id: 'bandwidth', title: 'generalOverview.panels.bandwidth', defaultVisible: true },
  { id: 'system', title: 'generalOverview.panels.system', defaultVisible: true },
  { id: 'jobs', title: 'generalOverview.panels.jobs', defaultVisible: true },
  { id: 'serves', title: 'generalOverview.panels.serves', defaultVisible: true },
  { id: 'automations', title: 'generalOverview.panels.automations', defaultVisible: true },
]);

export interface DashboardPanel extends PanelConfig {
  visible: boolean;
}

/** What an overview stores of its panel layout; older versions stored just the order. */
export type SavedPanelLayout = { order?: string[]; hidden?: string[] } | string[];

/** The panels of an overview in their built-in order and visibility. */
export function defaultPanels(all: readonly PanelConfig[]): DashboardPanel[] {
  return all.map(p => ({ ...p, visible: p.defaultVisible }));
}

/**
 * The saved order and visibility applied to the known panels. Saved ids that no longer exist
 * are dropped, panels the layout has not seen yet are appended with their default visibility,
 * and an empty or missing layout gives the defaults.
 */
export function applyPanelLayout(
  all: readonly PanelConfig[],
  saved: SavedPanelLayout | null | undefined
): DashboardPanel[] {
  const order = (Array.isArray(saved) ? saved : saved?.order) ?? [];
  if (order.length === 0) return defaultPanels(all);

  const hidden = new Set(Array.isArray(saved) ? [] : (saved?.hidden ?? []));
  const known = new Map(all.map(p => [p.id as string, p]));
  const ordered = order.flatMap(id => {
    const panel = known.get(id);
    return panel ? [{ ...panel, visible: !hidden.has(id) }] : [];
  });
  const seen = new Set(order);
  return [...ordered, ...defaultPanels(all.filter(p => !seen.has(p.id)))];
}

/** The part of the panels worth saving: their order and which of them are hidden. */
export function panelLayoutOf(panels: readonly DashboardPanel[]): {
  order: string[];
  hidden: string[];
} {
  return {
    order: panels.map(p => p.id),
    hidden: panels.filter(p => !p.visible).map(p => p.id),
  };
}

export interface BandwidthDetailItem {
  labelKey: string;
  bytesPerSec: number | undefined;
}

export interface BandwidthPreset {
  readonly value: string;
  readonly label?: string;
  readonly labelKey?: string;
}

export const BANDWIDTH_PRESETS: readonly BandwidthPreset[] = Object.freeze([
  { value: 'off', labelKey: 'generalOverview.bandwidth.unlimited' },
  { value: '1M', label: '1 MB/s' },
  { value: '5M', label: '5 MB/s' },
  { value: '10M', label: '10 MB/s' },
  { value: '50M', label: '50 MB/s' },
  { value: '10M:50M', label: '10M : 50M' },
]);

export interface JobStatItem {
  labelKey: string;
  value: string | number;
  error?: boolean;
  formatAsBytes?: boolean;
}

export interface FileBrowserItem {
  entry: Entry;
  meta: {
    remote: string;
    isLocal: boolean;
    remoteType?: string;
  };
}

export function fileBrowserItemKey(item: FileBrowserItem | null | undefined): string {
  if (!item) return '';
  const base = `${item.meta.remote}:${item.entry.Path}`;
  return item.entry.ID ? `${base}:${item.entry.ID}` : base;
}

export type CollectionType = 'starred' | 'bookmarks';

export type FilePickerMode = 'local' | 'remote' | 'both';
export type FilePickerSelection = 'files' | 'folders' | 'both';

export interface FilePickerConfig {
  mode: FilePickerMode;
  selection: FilePickerSelection;
  multi?: boolean;
  allowedRemotes?: string[];
  allowedExtensions?: string[];
  initialLocation?: string;
  preselect?: string[];
  minSelection?: number;
  requestId?: string;
}

export const DEFAULT_PICKER_OPTIONS: Readonly<FilePickerConfig> = Object.freeze({
  mode: 'both',
  selection: 'both',
  multi: false,
  minSelection: 0,
});

export interface FilePickerResult {
  items: FileBrowserItem[];
  paths: string[];
  cancelled: boolean;
  requestId?: string;
}

export interface NotifyOptions<T = unknown> {
  successKey?: string;
  successParams?: Record<string, unknown> | ((result: T) => Record<string, unknown>);
  errorKey?: string;
  errorParams?: Record<string, unknown>;
}

export interface BackupAnalysis {
  isEncrypted: boolean;
  archiveType: string;
  formatVersion: string;
  createdAt?: string;
  backupType?: string;
  userNote?: string;
  contents?: BackupContentsInfo;
}

export interface BackupContentsInfo {
  settings: boolean;
  backendConfig: boolean;
  rcloneConfig: boolean;
  remoteDefinitions: boolean;
  remoteCount?: number;
  remoteNames?: string[];
  profiles?: string[];
}

export interface ActionConfig {
  key: PrimaryActionType;
  label: string;
  icon: string;
  getTooltip: (remote: Remote) => string;
  getActiveState: (remote: Remote) => boolean;
}

export interface ActionViewModel {
  key: PrimaryActionType;
  label: string;
  icon: string;
  isSelected: boolean;
  isActive: boolean;
  position: number;
  canInteract: boolean;
  tooltip: string;
  ariaLabel: string;
  isLoading?: boolean;
}

export const ACTION_CONFIGS: readonly ActionConfig[] = Object.freeze(
  OPERATION_REGISTRY.filter(op => op.isPrimary).map(op => ({
    key: op.key as PrimaryActionType,
    label: op.actionLabel,
    icon: op.icon,
    getTooltip: (remote: Remote): string => {
      const state = (
        remote.status as unknown as Record<string, { active?: boolean } | undefined> | undefined
      )?.[op.key];
      return state?.active ? op.activeTooltip : op.inactiveTooltip;
    },
    getActiveState: (remote: Remote) =>
      !!(
        remote.status as unknown as Record<string, { active?: boolean } | undefined> | undefined
      )?.[op.key]?.active,
  }))
);

export interface OperationMeta {
  startIcon: string;
  stopIcon: string;
  startTooltip: string;
  stopTooltip: string;
  tone: PillTone;
}

export const TITLE_MAP: Readonly<Record<AppTab, string>> = Object.freeze({
  mount: 'overviews.headers.mount',
  operations: 'overviews.headers.operations',
  serve: 'overviews.headers.serve',
  general: 'overviews.headers.general',
});

export const ACTIVE_LABELS: Readonly<Partial<Record<AppTab, string>>> = Object.freeze({
  mount: 'overviews.status.labels.mounted',
  operations: 'overviews.status.labels.active',
});

export const INACTIVE_LABELS: Readonly<Partial<Record<AppTab, string>>> = Object.freeze({
  mount: 'overviews.status.labels.unmounted',
  operations: 'overviews.status.labels.inactive',
});

export const MODE_DEFAULTS: Readonly<Record<AppTab, PrimaryActionType[]>> = Object.freeze({
  general: ['mount', 'sync', 'bisync'],
  operations: ['sync', 'bisync', 'copy'],
  mount: ['mount'],
  serve: ['serve'],
});

/** The operations whose activity an overview tab is about; the general tab shows them all. */
export function operationsOfTab(tab: AppTab): readonly PrimaryActionType[] {
  switch (tab) {
    case 'mount':
      return ['mount'];
    case 'operations':
      return SYNC_TYPES;
    case 'serve':
      return ['serve'];
    default:
      return ALL_PRIMARY_ACTIONS;
  }
}

/** Whether a remote is running something this tab is about. */
export function isActiveOnTab(remote: Pick<Remote, 'status'>, tab: AppTab): boolean {
  return operationsOfTab(tab).some(op => remote.status[op].active);
}

export const OPERATION_META = Object.freeze(
  Object.fromEntries(
    OPERATION_REGISTRY.filter(op => op.isPrimary).map(op => [
      op.key,
      {
        startIcon: op.startIcon,
        stopIcon: op.stopIcon,
        startTooltip: op.startTooltip,
        stopTooltip: op.stopTooltip,
        tone: op.tone,
      },
    ])
  )
) as Readonly<Record<PrimaryActionType, OperationMeta>>;

export interface OpenInFilesEvent {
  remoteName: string;
  path?: string;
  profileName?: string;
  operationType?: PrimaryActionType;
}

/** A folder a card button can open in the file browser. */
export interface BrowseTarget {
  /** Stable identity, used to track the menu entries. */
  key: string;
  path: string;
  icon: string;
  tone: PillTone;
  /** i18n key of the label; `label` is shown as is when there is none. */
  labelKey?: string;
  label?: string;
  /** Short folder name, shown in brackets after the label. */
  detail: string;
  isOpening: boolean;
}

export interface OpenableFolder extends BrowseTarget {
  operation: PrimaryActionType;
  profile: string;
}

export type OnboardingCardKey =
  | 'welcome'
  | 'features'
  | 'installRclone'
  | 'installPlugin'
  | 'androidAccess'
  | 'selectConfig'
  | 'passwordRequired'
  | 'selectMainUi'
  | 'ready';

export interface OnboardingCard {
  key: OnboardingCardKey;
  title: string;
  content: string;
  image?: string;
}

export type OnboardingAction =
  'install-rclone' | 'install-plugin' | 'config-next' | 'unlock' | 'finish' | 'next';

export const DEFAULT_ONBOARDING_IMAGE = '../assets/rclone-manager.svg';

export type MainView = 'main_menu' | 'nautilus' | 'flow';

export interface RemoteAboutData {
  remote: { displayName: string; normalizedName: string; type?: string };
}

export interface ExpiryOption {
  value: string;
  label: string;
}

export type PageType = 'home' | string;

export type GroupedRCloneOptions = Record<string, Record<string, RcConfigOption[]>>;

export interface RCloneService {
  name: string;
  expanded: boolean;
  categories: string[];
}

export interface RCloneFlagsSearchResult {
  service: string;
  category: string;
  option: RcConfigOption;
}

export interface ServiceConfig {
  icon: string;
  description: string;
  mainCategory: string;
}

export interface BackupExportOption {
  id: string;
  label: string;
  description: string;
  icon: string;
  categoryType?: string;
  isTranslationKey?: boolean;
}

export interface NautilusTabItem {
  id: number;
  title: string;
  path: string;
  remote: { name: string; label: string } | null;
}

export interface TranslationResult {
  key: string;
  params?: Record<string, unknown>;
}

export interface ChipDef {
  controlKey: string;
  displayKey: string;
  currentValue: unknown;
  displayValue: string;
  fullValue: string;
  isChanged: boolean;
  isActive: boolean;
  field: RcConfigOption;
}

export interface VfsInstance {
  name: string;
  stats: VfsStats | null;
  queue: VfsQueueItem[];
  pollInterval: string;
  pollIntervalSupported?: boolean;
}

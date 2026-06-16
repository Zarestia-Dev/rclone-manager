import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { PrimaryActionType } from './operations';
import { Remote } from './remotes';

// =============================================================================
// NAVIGATION / UI TYPES
// =============================================================================

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

/**
 * The four top-level navigation tabs in the dashboard.
 *
 * Three of these (`mount`, `sync`, `serve`) correspond directly to a
 * PrimaryActionType and are used to drive both tab display and operation
 * dispatch. `general` is a pure overview tab with no associated operation.
 *
 * Use `OperationTab` when you need a type that excludes `general` — i.e.
 * wherever a tab value is guaranteed to map to a runnable operation.
 */
export type AppTab = 'mount' | 'operations' | 'serve' | 'general';

/**
 * A subset of AppTab that always corresponds to a runnable PrimaryActionType.
 * Use this for component inputs that should never receive `'general'`.
 */
export type OperationTab = Exclude<AppTab, 'general'>; // 'mount' | 'operations' | 'serve'

export interface ModeConfig {
  label: string;
  icon: string;
  activeTitle: string;
  inactiveTitle: string;
}

export const MODE_CONFIG: Record<OperationTab, ModeConfig> = {
  mount: {
    label: 'appOverview.labels.mount',
    icon: 'mount',
    activeTitle: 'appOverview.panelTitles.mountedRemotes',
    inactiveTitle: 'appOverview.panelTitles.unmountedRemotes',
  },
  operations: {
    label: 'appOverview.labels.startOperations',
    icon: 'operations',
    activeTitle: 'appOverview.panelTitles.activeOperations',
    inactiveTitle: 'appOverview.panelTitles.inactiveRemotes',
  },
  serve: {
    label: 'appOverview.labels.startServe',
    icon: 'satellite-dish',
    activeTitle: 'appOverview.panelTitles.activeServes',
    inactiveTitle: 'appOverview.panelTitles.availableRemotes',
  },
};

export interface ModalSize {
  width: string;
  maxWidth: string;
  minWidth: string;
  height: string;
  maxHeight: string;
  minHeight?: string;
  disableClose?: boolean;
}

export const STANDARD_MODAL_SIZE: ModalSize = {
  width: '90vw',
  maxWidth: '680px',
  minWidth: '362px',
  height: '80vh',
  maxHeight: '800px',
  minHeight: '240px',
  disableClose: true,
};

export const CONFIG_MODAL_SIZE: ModalSize = {
  width: '95vw',
  maxWidth: '1024px',
  minWidth: '362px',
  height: '90vh',
  maxHeight: '860px',
  disableClose: true,
};

export const ABOUT_MODAL_SIZE: ModalSize = {
  width: '362px',
  maxWidth: '362px',
  minWidth: '362px',
  height: '80vh',
  maxHeight: '650px',
  minHeight: '240px',
  disableClose: true,
};

export interface ConfirmDialogData {
  title: string;
  message: string;
  confirmText?: string; // Defaults to "Yes"
  cancelText?: string; // Defaults to "No"
  icon?: string; // Optional icon name for modal header
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

export interface ExportOption {
  readonly value: ExportType;
  readonly label: string;
  readonly description: string;
  readonly icon: string;
}

export interface PasswordPromptResult {
  password: string;
  stored: boolean;
}

export type Theme = 'light' | 'dark' | 'system';

export type ConnectionStatus = 'online' | 'offline' | 'checking';

export type PanelId = 'remotes' | 'bandwidth' | 'system' | 'jobs' | 'automations' | 'serves';

export interface PanelConfig {
  id: PanelId;
  title: string;
  defaultVisible: boolean;
}

export const SCROLL_DELAY_MS = 60;

export const ALL_PANELS: PanelConfig[] = [
  { id: 'remotes', title: 'generalOverview.panels.remotes', defaultVisible: true },
  { id: 'bandwidth', title: 'generalOverview.panels.bandwidth', defaultVisible: true },
  { id: 'system', title: 'generalOverview.panels.system', defaultVisible: true },
  { id: 'jobs', title: 'generalOverview.panels.jobs', defaultVisible: true },
  { id: 'automations', title: 'generalOverview.panels.automations', defaultVisible: true },
  { id: 'serves', title: 'generalOverview.panels.serves', defaultVisible: true },
];

export interface DashboardPanel extends PanelConfig {
  visible: boolean;
}

export interface BandwidthDetailItem {
  labelKey: string;
  bytesPerSec: number | undefined;
}

export interface JobStatItem {
  labelKey: string;
  value: string | number;
  error?: boolean;
  formatAsBytes?: boolean;
}

import { Entry } from './remote-config';

/**
 * Represents a file or folder with its full context attached.
 * This is the "Source of Truth" for any file object passed around the UI.
 */
export interface FileBrowserItem {
  /** The actual file/folder data returned by rclone */
  entry: Entry;

  /** UI context metadata (where the file lives and how to render it) */
  meta: {
    remote: string; // e.g. "gdrive:"
    isLocal: boolean;
    remoteType?: string; // e.g. 's3', 'drive', etc. (used for icons)
  };
}

export type CollectionType = 'starred' | 'bookmarks';

// --- File Picker ---
export type FilePickerMode = 'local' | 'remote' | 'both';
export type FilePickerSelection = 'files' | 'folders' | 'both';

export interface FilePickerConfig {
  /** What roots are visible */
  mode: FilePickerMode; // 'local' | 'remote' | 'both'
  /** What can be selected */
  selection: FilePickerSelection; // 'files' | 'folders' | 'both'
  /** Allow multi-select. Default false for new API */
  multi?: boolean;
  /** Optional whitelist for remote roots and starred/bookmarks */
  allowedRemotes?: string[];
  /** Optional file extension filter for selectable files (e.g. ['.jpg','.png']) */
  allowedExtensions?: string[];
  /** Initial location like '/home/user', 'gdrive:' or 'gdrive:Photos' */
  initialLocation?: string;
  /** Preselected full paths */
  preselect?: string[];
  /** Minimum selection to enable Confirm (default 0) */
  minSelection?: number;
  /** Optional request id to correlate picker result */
  requestId?: string;
}

export const DEFAULT_PICKER_OPTIONS: FilePickerConfig = {
  mode: 'both',
  selection: 'both',
  multi: false,
  minSelection: 0,
};

export interface FilePickerResult {
  /** The selected items with full context. Each item knows its remote, isLocal, path, and full entry. */
  items: FileBrowserItem[];
  /** Full normalized paths like '/home/user/...' or 'remote:path'. Kept for backward compatibility. */
  paths: string[];
  cancelled: boolean;
  /** Optional request id that matches the open request */
  requestId?: string;
}

export interface NotifyOptions {
  successKey?: string;
  successParams?: Record<string, unknown>;
  errorKey?: string;
  errorParams?: Record<string, unknown>;
  showSuccess?: boolean;
  showError?: boolean;
}

// Matches the `BackupAnalysis` struct in `core/settings/backup/backup_types.rs`
export interface BackupAnalysis {
  isEncrypted: boolean;
  archiveType: string;
  formatVersion: string;
  isLegacy?: boolean;
  createdAt?: string;
  backupType?: string;
  userNote?: string;
  contents?: BackupContentsInfo;
}

// Matches the `BackupContentsInfo` struct
export interface BackupContentsInfo {
  settings: boolean;
  backendConfig: boolean;
  rcloneConfig: boolean;
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
  /** 1-based position in primaryActions, 0 when not selected. */
  position: number;
  /** False when max actions are selected and this action is not one of them. */
  canInteract: boolean;
  /** Already a translation key — apply | translate in template. */
  tooltip: string;
  /** Already translated — do NOT apply | translate in template. */
  ariaLabel: string;
}

export const ACTION_CONFIGS: ActionConfig[] = [
  {
    key: 'mount',
    label: 'actions.mount',
    icon: 'mount',
    getTooltip: remote => (remote.status.mount.active ? 'mount.mounted' : 'mount.toggleAction'),
    getActiveState: remote => remote.status.mount.active || false,
  },
  {
    key: 'sync',
    label: 'actions.sync',
    icon: 'refresh',
    getTooltip: remote =>
      remote.status.sync.active ? 'operations.syncing' : 'operations.toggleSync',
    getActiveState: remote => remote.status.sync.active || false,
  },
  {
    key: 'copy',
    label: 'actions.copy',
    icon: 'copy',
    getTooltip: remote =>
      remote.status.copy.active ? 'operations.copying' : 'operations.toggleCopy',
    getActiveState: remote => remote.status.copy.active || false,
  },
  {
    key: 'move',
    label: 'actions.move',
    icon: 'move',
    getTooltip: remote =>
      remote.status.move.active ? 'operations.moving' : 'operations.toggleMove',
    getActiveState: remote => remote.status.move.active || false,
  },
  {
    key: 'bisync',
    label: 'actions.bisync',
    icon: 'right-left',
    getTooltip: remote =>
      remote.status.bisync.active ? 'operations.bisyncActive' : 'operations.toggleBisync',
    getActiveState: remote => remote.status.bisync.active || false,
  },
  {
    key: 'serve',
    label: 'actions.serve',
    icon: 'serve',
    getTooltip: remote => (remote.status.serve.active ? 'serve.serving' : 'serve.toggleAction'),
    getActiveState: remote => remote.status.serve.active || false,
  },
];

export interface OperationMeta {
  startIcon: string;
  stopIcon: string;
  startTooltip: string;
  stopTooltip: string;
  cssClass: string;
}

export const TITLE_MAP: Record<AppTab, string> = {
  mount: 'overviews.headers.mount',
  operations: 'overviews.headers.operations',
  serve: 'overviews.headers.serve',
  general: 'overviews.headers.general',
};

export const ACTIVE_LABELS: Partial<Record<AppTab, string>> = {
  mount: 'overviews.status.labels.mounted',
  operations: 'overviews.status.labels.active',
};

export const INACTIVE_LABELS: Partial<Record<AppTab, string>> = {
  mount: 'overviews.status.labels.unmounted',
  operations: 'overviews.status.labels.inactive',
};

export const MODE_DEFAULTS: Record<AppTab, PrimaryActionType[]> = {
  general: ['mount', 'sync', 'bisync'],
  operations: ['sync', 'bisync', 'copy', 'move'],
  mount: ['mount'],
  serve: ['serve'],
};

export const OPERATION_META: Record<PrimaryActionType, OperationMeta> = {
  mount: {
    startIcon: 'mount',
    stopIcon: 'eject',
    startTooltip: 'overviews.remoteCard.actions.mount',
    stopTooltip: 'overviews.remoteCard.actions.unmount',
    cssClass: 'accent',
  },
  sync: {
    startIcon: 'refresh',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startSync',
    stopTooltip: 'overviews.remoteCard.actions.stopSync',
    cssClass: 'primary',
  },
  copy: {
    startIcon: 'copy',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startCopy',
    stopTooltip: 'overviews.remoteCard.actions.stopCopy',
    cssClass: 'yellow',
  },
  move: {
    startIcon: 'move',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startMove',
    stopTooltip: 'overviews.remoteCard.actions.stopMove',
    cssClass: 'orange',
  },
  bisync: {
    startIcon: 'right-left',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startBisync',
    stopTooltip: 'overviews.remoteCard.actions.stopBisync',
    cssClass: 'purple',
  },
  serve: {
    startIcon: 'satellite-dish',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startServe',
    stopTooltip: 'overviews.remoteCard.actions.stopServe',
    cssClass: 'accent',
  },
};

export interface OpenInFilesEvent {
  remoteName: string;
  path?: string;
}

export interface OpenableFolder {
  operation: PrimaryActionType;
  profile: string;
  cssClass: string;
  tooltip: string;
  path: string;
  isLocal: boolean;
  icon: string;
}

// ── Consolidation of local UI types ──────────────────────────────────────────

export interface OnboardingCard {
  key: string;
  image: string;
  title: string;
  content: string;
}

export type OnboardingAction =
  | 'install-rclone'
  | 'install-plugin'
  | 'config-next'
  | 'unlock'
  | 'finish'
  | 'next';

export interface RemoteAboutData {
  remote: { displayName: string; normalizedName: string; type?: string };
}

export interface ExpiryOption {
  value: string;
  label: string;
}

export type PageType = 'home' | string;

import { RcConfigOption } from './remote-config';

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

import { VfsStats, VfsQueueItem } from 'src/app/services/operations/vfs.service';

export interface VfsInstance {
  name: string;
  stats: VfsStats | null;
  queue: VfsQueueItem[];
  pollInterval: string;
  pollIntervalSupported?: boolean;
}

// ── GNOME / Adwaita Light Syntax Highlighting ──
// Colors inspired by GNOME Builder's light theme and Adwaita palette
export const gnomeLightHighlighting = HighlightStyle.define([
  { tag: tags.keyword, color: '#0d7377' }, // Teal — keywords (if, const, return)
  { tag: tags.controlKeyword, color: '#0d7377', fontWeight: '500' },
  { tag: tags.definitionKeyword, color: '#0d7377' },
  { tag: tags.moduleKeyword, color: '#0d7377' },
  { tag: tags.function(tags.variableName), color: '#1a5fb4' }, // Blue — function names
  { tag: tags.function(tags.definition(tags.variableName)), color: '#1a5fb4', fontWeight: '500' },
  { tag: tags.string, color: '#c64600' }, // Orange — strings
  { tag: tags.number, color: '#813d9c' }, // Purple — numbers
  { tag: tags.bool, color: '#813d9c' },
  { tag: tags.null, color: '#813d9c', fontStyle: 'italic' },
  { tag: tags.comment, color: '#5e5c64', fontStyle: 'italic' }, // Dim gray — comments
  { tag: tags.lineComment, color: '#5e5c64', fontStyle: 'italic' },
  { tag: tags.blockComment, color: '#5e5c64', fontStyle: 'italic' },
  { tag: tags.typeName, color: '#1a5fb4' }, // Blue — types
  { tag: tags.className, color: '#1a5fb4', fontWeight: '500' },
  { tag: tags.propertyName, color: '#26a269' }, // Green — properties
  { tag: tags.definition(tags.propertyName), color: '#26a269' },
  { tag: tags.variableName, color: '#241f31' }, // Near-black — variables
  { tag: tags.definition(tags.variableName), color: '#241f31' },
  { tag: tags.operator, color: '#0d7377' }, // Teal — operators
  { tag: tags.punctuation, color: '#77767b' }, // Gray — punctuation
  { tag: tags.bracket, color: '#5e5c64' },
  { tag: tags.meta, color: '#813d9c' }, // Purple — decorators / meta
  { tag: tags.attributeName, color: '#26a269' }, // Green — HTML/XML attributes
  { tag: tags.attributeValue, color: '#c64600' }, // Orange — attribute values
  { tag: tags.tagName, color: '#1a5fb4' }, // Blue — HTML/XML tags
  { tag: tags.heading, color: '#1a5fb4', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.link, color: '#1a5fb4', textDecoration: 'underline' },
  { tag: tags.url, color: '#1a5fb4' },
  { tag: tags.regexp, color: '#a51d2d' }, // Red — regex
  { tag: tags.escape, color: '#a51d2d' },
  { tag: tags.special(tags.string), color: '#a51d2d' },
]);

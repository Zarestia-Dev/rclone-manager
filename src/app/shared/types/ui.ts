import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { PrimaryActionType } from './operations';
import { Remote } from './remotes';
import { OPERATION_REGISTRY } from './operation-registry';
import { Entry, RcConfigOption } from './remote-config';
import { VfsStats, VfsQueueItem } from 'src/app/services/operations/vfs.service';

export type AppTab = 'mount' | 'operations' | 'serve' | 'general';
export const APP_TABS: readonly AppTab[] = ['mount', 'operations', 'serve', 'general'] as const;
export type OperationTab = Exclude<AppTab, 'general'>;

export interface ModeConfig {
  label: string;
  icon: string;
  activeTitle: string;
  inactiveTitle: string;
}

export const MODE_CONFIG: Readonly<Record<OperationTab, ModeConfig>> = Object.freeze({
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

export const ALL_PANELS: readonly PanelConfig[] = Object.freeze([
  { id: 'remotes', title: 'generalOverview.panels.remotes', defaultVisible: true },
  { id: 'bandwidth', title: 'generalOverview.panels.bandwidth', defaultVisible: true },
  { id: 'system', title: 'generalOverview.panels.system', defaultVisible: true },
  { id: 'jobs', title: 'generalOverview.panels.jobs', defaultVisible: true },
  { id: 'automations', title: 'generalOverview.panels.automations', defaultVisible: true },
  { id: 'serves', title: 'generalOverview.panels.serves', defaultVisible: true },
]);

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

export interface FileBrowserItem {
  entry: Entry;
  meta: {
    remote: string;
    isLocal: boolean;
    remoteType?: string;
  };
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

export interface NotifyOptions {
  successKey?: string;
  successParams?: Record<string, unknown>;
  errorKey?: string;
  errorParams?: Record<string, unknown>;
  showSuccess?: boolean;
  showError?: boolean;
}

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
      const state = (remote.status as any)[op.key];
      return state?.active ? op.activeTooltip : op.inactiveTooltip;
    },
    getActiveState: (remote: Remote) => !!(remote.status as any)[op.key]?.active,
  }))
);

export interface OperationMeta {
  startIcon: string;
  stopIcon: string;
  startTooltip: string;
  stopTooltip: string;
  cssClass: string;
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

export const OPERATION_META = Object.freeze(
  Object.fromEntries(
    OPERATION_REGISTRY.filter(op => op.isPrimary).map(op => [
      op.key,
      {
        startIcon: op.startIcon,
        stopIcon: op.stopIcon,
        startTooltip: op.startTooltip,
        stopTooltip: op.stopTooltip,
        cssClass: op.cssClass,
      },
    ])
  )
) as Readonly<Record<PrimaryActionType, OperationMeta>>;

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

// ── GNOME / Adwaita Light Syntax Highlighting ──
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

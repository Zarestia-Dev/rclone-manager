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
export type AppTab = 'mount' | 'sync' | 'serve' | 'general';

/**
 * A subset of AppTab that always corresponds to a runnable PrimaryActionType.
 * Use this for component inputs that should never receive `'general'`.
 */
export type OperationTab = Exclude<AppTab, 'general'>; // 'mount' | 'sync' | 'serve'

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

export interface DashboardPanel {
  id: string;
  title: string;
  visible: boolean;
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

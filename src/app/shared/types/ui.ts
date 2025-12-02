export type AppTab = 'mount' | 'sync' | 'serve' | 'general';

export interface ModalSize {
  width: string;
  maxWidth: string;
  minWidth: string;
  height: string;
  maxHeight: string;
  disableClose?: boolean;
}

export const STANDARD_MODAL_SIZE: ModalSize = {
  width: '90vw',
  maxWidth: '642px',
  minWidth: '360px',
  height: '80vh',
  maxHeight: '700px',
  disableClose: true,
};

export interface ConfirmDialogData {
  title: string;
  message: string;
  confirmText?: string; // Defaults to "Yes"
  cancelText?: string; // Defaults to "No"
}

export enum ExportType {
  All = 'All',
  Settings = 'Settings',
  Remotes = 'Remotes',
  RemoteConfigs = 'RemoteConfigs',
  SpecificRemote = 'SpecificRemote',
  RCloneBackend = 'RCloneBackend',
}

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

export interface ToastMessage {
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
}

export interface PasswordPromptResult {
  password: string;
  stored: boolean;
}

/**
 * Animation constants for consistent timing and easing
 */
export const ANIMATION_CONSTANTS = {
  // Durations
  DURATION: {
    FAST: '200ms',
    NORMAL: '300ms',
    SLOW: '500ms',
    EXTRA_SLOW: '600ms',
  },

  // Easing functions
  EASING: {
    EASE_IN_OUT: 'ease-in-out',
    EASE_IN: 'ease-in',
    EASE_OUT: 'ease-out',
    SMOOTH: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
    SHARP: 'cubic-bezier(0.55, 0.06, 0.68, 0.19)',
  },

  // Common delays
  DELAY: {
    SHORT: '100ms',
    MEDIUM: '200ms',
    LONG: '300ms',
  },
};

/**
 * Animation configuration interface
 */
export interface AnimationConfig {
  duration?: string;
  delay?: string;
  easing?: string;
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
    fsType: 'local' | 'remote';
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
}

export interface FilePickerResult {
  /** Full normalized paths like '/home/user/...' or 'remote:path' */
  paths: string[];
  cancelled: boolean;
}

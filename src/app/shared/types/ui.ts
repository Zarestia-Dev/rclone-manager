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
}

export interface ExportModalData {
  remoteName?: string;
  defaultExportType?: ExportType;
}

export interface ExportOption {
  readonly value: ExportType;
  readonly label: string;
  readonly description: string;
}

export interface InputField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select' | 'folder';
  required: boolean;
  options?: string[]; // for select type
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

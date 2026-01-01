import { Entry, FsInfo, RemoteSettings } from '@app/types';

/**
 * Base interface for modal data that requires a remote name
 */
export interface BaseModalData {
  remoteName: string;
}

/**
 * Data for RemoteAboutModalComponent
 */
export interface RemoteAboutModalData {
  remote: {
    displayName: string;
    normalizedName: string;
    type?: string;
  };
}

/**
 * Data for PropertiesModalComponent
 */
export interface PropertiesModalData extends BaseModalData {
  path: string;
  isLocal: boolean;
  item?: Entry | null;
  remoteType?: string;
  fsInfo?: FsInfo;
}

/**
 * Data for LogsModalComponent
 */
export interface LogsModalData extends BaseModalData {
  jobId?: number;
}

/**
 * Data for RemoteConfigModalComponent
 */
export interface RemoteConfigModalData {
  name?: string;
  editTarget?: string;
  cloneTarget?: boolean;
  existingConfig?: RemoteSettings & { remoteSpecs?: unknown };
  restrictMode?: boolean;
  initialSection?: string;
  targetProfile?: string;
}

/**
 * Data for KeyboardShortcutsModalComponent
 */
export interface KeyboardShortcutsModalData {
  category?: string;
}

// Note: ExportModalData and PasswordPromptResult are already defined in ui.ts
// Use those existing types instead of redefining here

import { Injectable, inject } from '@angular/core';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';

import { RemoteConfigModalComponent } from '../../features/modals/remote-management/remote-config-modal/remote-config-modal.component';
import { QuickAddRemoteComponent } from '../../features/modals/remote-management/quick-add-remote/quick-add-remote.component';
import { ExportModalComponent } from '../../features/modals/settings/export-modal/export-modal.component';
import { BackendModalComponent } from '../../features/modals/settings/backend-modal/backend-modal.component';
import { LogsModalComponent } from '../../features/modals/settings/logs-modal/logs-modal.component';
import { PreferencesModalComponent } from '../../features/modals/settings/preferences-modal/preferences-modal.component';
import { AboutModalComponent } from '../../features/modals/settings/about-modal/about-modal.component';
import { RcloneConfigModalComponent } from '../../features/modals/settings/rclone-config-modal/rclone-config-modal.component';
import { KeyboardShortcutsModalComponent } from '../../features/modals/settings/keyboard-shortcuts-modal/keyboard-shortcuts-modal.component';
import { RestorePreviewModalComponent } from '../../features/modals/settings/restore-preview-modal/restore-preview-modal.component';
import { RemoteSettings, STANDARD_MODAL_SIZE } from '@app/types';
import { BackupAnalysis } from '../settings/backup-restore.service';

export interface RemoteConfigModalOptions {
  remoteName?: string;
  editTarget?: string;
  existingConfig?: RemoteSettings;
  restrictMode?: boolean;
  initialSection?: string;
  targetProfile?: string;
  cloneTarget?: boolean;
}

export interface ExportModalOptions {
  remoteName?: string;
  defaultExportType?: 'FullBackup' | 'AllConfigs' | 'SpecificRemote';
}

export interface RestorePreviewOptions {
  backupPath: string;
  analysis: BackupAnalysis;
}

/**
 * Centralized service for opening modal dialogs.
 * Reduces boilerplate in components and provides consistent modal configuration.
 */
@Injectable({
  providedIn: 'root',
})
export class ModalService {
  private readonly dialog = inject(MatDialog);

  // ============================================================================
  // Remote Management Modals
  // ============================================================================

  openQuickAddRemote(): MatDialogRef<QuickAddRemoteComponent> {
    return this.dialog.open(QuickAddRemoteComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
    });
  }

  openRemoteConfig(
    options: RemoteConfigModalOptions = {}
  ): MatDialogRef<RemoteConfigModalComponent> {
    return this.dialog.open(RemoteConfigModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: {
        name: options.remoteName,
        editTarget: options.editTarget,
        existingConfig: options.existingConfig,
        restrictMode: options.restrictMode ?? true,
        initialSection: options.initialSection,
        targetProfile: options.targetProfile,
        cloneTarget: options.cloneTarget,
      },
    });
  }

  // ============================================================================
  // Settings Modals
  // ============================================================================

  openLogs(remoteName: string): MatDialogRef<LogsModalComponent> {
    return this.dialog.open(LogsModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: { remoteName },
    });
  }

  openExport(options: ExportModalOptions = {}): MatDialogRef<ExportModalComponent> {
    return this.dialog.open(ExportModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: {
        remoteName: options.remoteName,
        defaultExportType: options.defaultExportType ?? 'FullBackup',
      },
    });
  }

  openBackend(): MatDialogRef<BackendModalComponent> {
    return this.dialog.open(BackendModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: false,
    });
  }

  openPreferences(): MatDialogRef<PreferencesModalComponent> {
    return this.dialog.open(PreferencesModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
    });
  }

  openRcloneConfig(): MatDialogRef<RcloneConfigModalComponent> {
    return this.dialog.open(RcloneConfigModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
    });
  }

  openKeyboardShortcuts(): MatDialogRef<KeyboardShortcutsModalComponent> {
    return this.dialog.open(KeyboardShortcutsModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
    });
  }

  openAbout(): MatDialogRef<AboutModalComponent> {
    return this.dialog.open(AboutModalComponent, {
      width: '362px',
      maxWidth: '362px',
      minWidth: '362px',
      height: '80vh',
      maxHeight: '600px',
      minHeight: '240px',
      disableClose: true,
    });
  }

  openRestorePreview(options: RestorePreviewOptions): MatDialogRef<RestorePreviewModalComponent> {
    return this.dialog.open(RestorePreviewModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: {
        backupPath: options.backupPath,
        analysis: options.analysis,
      },
    });
  }
}

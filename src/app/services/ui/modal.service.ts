import { Injectable, inject } from '@angular/core';
import { MatDialog, MatDialogConfig, MatDialogRef } from '@angular/material/dialog';

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
import { JobDetailModalComponent } from '../../features/modals/job-detail-modal/job-detail-modal.component';
import { RemoteAboutModalComponent } from '../../features/modals/remote/remote-about-modal.component';
import { PropertiesModalComponent } from '../../features/modals/properties/properties-modal.component';
import { AlertsModalComponent } from '../../features/modals/alerts-modal/alerts-modal.component';
import { AlertActionEditorComponent } from '../../features/modals/alerts-modal/actions/alert-action-editor.component';
import { AlertRuleEditorComponent } from '../../features/modals/alerts-modal/rules/alert-rule-editor.component';
import {
  InputModalComponent,
  InputModalData,
} from '../../shared/modals/input-modal/input-modal.component';
import { ArchiveCreateModalComponent } from '../../shared/modals/archive-create-modal/archive-create-modal.component';
import { ConfirmModalComponent } from '../../shared/modals/confirm-modal/confirm-modal.component';
import {
  AlertAction,
  AlertRule,
  RemoteSettings,
  RemoteFeatures,
  STANDARD_MODAL_SIZE,
  CONFIG_MODAL_SIZE,
  ABOUT_MODAL_SIZE,
  ConfirmDialogData,
} from '@app/types';
import { JobInfo } from '../../shared/types/jobs';
import { BackupAnalysis } from '../settings/backup-restore.service';

export interface RemoteConfigModalOptions {
  remoteName?: string;
  remoteType?: string;
  editTarget?: string;
  existingConfig?: RemoteSettings;
  initialSection?: string;
  targetProfile?: string;
  cloneTarget?: boolean;
  autoAddProfile?: boolean;
}

export interface ExportModalOptions {
  remoteName?: string;
  defaultExportType?: 'FullBackup' | 'AllConfigs' | 'SpecificRemote';
}

export interface PropertiesModalOptions {
  remoteName?: string;
  path?: string;
  isLocal?: boolean;
  item?: any;
  remoteType?: string;
  features?: RemoteFeatures;
  height?: string;
  maxHeight?: string;
  width?: string;
  maxWidth?: string;
}

export interface RemoteAboutModalOptions {
  displayName: string;
  normalizedName: string;
  type: string;
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
      ...CONFIG_MODAL_SIZE,
      disableClose: true,
      data: {
        name: options.remoteName,
        remoteType: options.remoteType,
        editTarget: options.editTarget,
        existingConfig: options.existingConfig,
        initialSection: options.initialSection,
        targetProfile: options.targetProfile,
        cloneTarget: options.cloneTarget,
        autoAddProfile: options.autoAddProfile,
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

  /**
   * Open the Job Detail modal for a given job info object.
   * Uses the standard modal sizing and provides a default panelClass for styling.
   */
  openJobDetail(job: JobInfo): MatDialogRef<JobDetailModalComponent> {
    return this.dialog.open(JobDetailModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: job,
    });
  }

  openProperties(options: PropertiesModalOptions): MatDialogRef<PropertiesModalComponent> {
    return this.dialog.open(PropertiesModalComponent, {
      data: {
        remoteName: options.remoteName,
        path: options.path,
        isLocal: options.isLocal,
        item: options.item,
        remoteType: options.remoteType,
        features: options.features,
      },
      height: options.height ?? '60vh',
      maxHeight: options.maxHeight ?? '800px',
      width: options.width ?? '60vw',
      maxWidth: options.maxWidth ?? '400px',
    });
  }

  openRemoteAbout(options: RemoteAboutModalOptions): MatDialogRef<RemoteAboutModalComponent> {
    return this.dialog.open(RemoteAboutModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: {
        remote: {
          displayName: options.displayName,
          normalizedName: options.normalizedName,
          type: options.type,
        },
      },
    });
  }

  openKeyboardShortcuts(data?: {
    nautilus?: boolean;
  }): MatDialogRef<KeyboardShortcutsModalComponent> {
    return this.dialog.open(KeyboardShortcutsModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data,
    });
  }

  openAbout(): MatDialogRef<AboutModalComponent> {
    return this.dialog.open(AboutModalComponent, {
      ...ABOUT_MODAL_SIZE,
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

  openAlerts(): MatDialogRef<AlertsModalComponent> {
    return this.dialog.open(AlertsModalComponent, {
      width: '90vw',
      maxWidth: '1200px',
      height: '85vh',
      disableClose: false,
      panelClass: 'alerts-modal-panel',
    });
  }

  openAlertActionEditor(data?: AlertAction): MatDialogRef<AlertActionEditorComponent, AlertAction> {
    return this.dialog.open(AlertActionEditorComponent, {
      width: '600px',
      disableClose: false,
      data,
    });
  }

  openAlertRuleEditor(data?: AlertRule): MatDialogRef<AlertRuleEditorComponent, AlertRule> {
    return this.dialog.open(AlertRuleEditorComponent, {
      width: '600px',
      disableClose: true,
      data,
    });
  }

  openArchiveCreate(data: {
    items: any[];
    defaultName: string;
  }): MatDialogRef<ArchiveCreateModalComponent> {
    return this.dialog.open(ArchiveCreateModalComponent, {
      width: '450px',
      disableClose: true,
      data,
    });
  }

  // ============================================================================
  // Shared / Generic Modals
  // ============================================================================

  /**
   * Open a generic confirm dialog with a message and confirm/cancel buttons.
   */
  openConfirm(
    data: ConfirmDialogData,
    config: Partial<MatDialogConfig<ConfirmDialogData>> = {}
  ): MatDialogRef<ConfirmModalComponent, boolean> {
    return this.dialog.open(ConfirmModalComponent, {
      maxWidth: '480px',
      disableClose: true,
      data,
      ...config,
    });
  }

  /**
   * Open a generic input dialog for single or multiple text inputs.
   */
  openInput<T = any>(
    data: InputModalData,
    config: Partial<MatDialogConfig<InputModalData>> = {}
  ): MatDialogRef<InputModalComponent, T> {
    return this.dialog.open(InputModalComponent, {
      minWidth: '362px',
      disableClose: true,
      data,
      ...config,
    });
  }

  // ============================================================================
  // Animated Close Utility
  // ============================================================================

  /**
   * Close a dialog with a slide-down animation.
   * Use this instead of dialogRef.close() for animated closing on mobile.
   *
   * @param dialogRef - The MatDialogRef to close
   * @param result - Optional result to pass to afterClosed()
   * @param animationDuration - Duration of the close animation in ms (default: 200)
   */
  animatedClose<T, R = unknown>(
    dialogRef: MatDialogRef<T>,
    result?: R,
    animationDuration = 200
  ): void {
    // Only apply animation on mobile widths where bottom sheet behavior is active
    const isMobile = window.innerWidth <= 450;

    if (isMobile) {
      const dialogContainer = document.getElementById(dialogRef.id);

      if (dialogContainer) {
        dialogContainer.classList.add('closing');

        // Wait for animation to complete, then close
        setTimeout(() => {
          dialogRef.close(result);
        }, animationDuration);
      } else {
        // Fallback if container not found
        dialogRef.close(result);
      }
    } else {
      // Desktop - close immediately
      dialogRef.close(result);
    }
  }
}

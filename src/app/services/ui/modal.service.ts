import { Injectable, inject, Injector } from '@angular/core';
import { MatDialog, MatDialogConfig, MatDialogRef } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { Subject, Observable } from 'rxjs';
import { Window } from '@tauri-apps/api/window';

import { RemoteConfigModalComponent } from '../../features/modals/remote-management/remote-config-modal/remote-config-modal.component';
import { QuickAddRemoteComponent } from '../../features/modals/remote-management/quick-add-remote/quick-add-remote.component';
import { ExportModalComponent } from '../../features/modals/settings/export-modal/export-modal.component';
import { BackendModalComponent } from '../../features/modals/settings/backend-modal/backend-modal.component';
import { LogsModalComponent } from '../../features/modals/settings/logs-modal/logs-modal.component';
import { PreferencesModalComponent } from '../../features/modals/settings/preferences-modal/preferences-modal.component';
import { AboutModalComponent } from '../../features/modals/settings/about-modal/about-modal.component';
import { RcloneFlagsModalComponent } from '../../features/modals/settings/rclone-flags-modal/rclone-flags-modal.component';
import { KeyboardShortcutsModalComponent } from '../../features/modals/settings/keyboard-shortcuts-modal/keyboard-shortcuts-modal.component';
import { RestorePreviewModalComponent } from '../../features/modals/settings/restore-preview-modal/restore-preview-modal.component';
import { JobDetailModalComponent } from '../../features/modals/job-detail-modal/job-detail-modal.component';
import { RemoteAboutModalComponent } from '../../features/modals/remote/remote-about-modal.component';
import { PropertiesModalComponent } from '../../features/modals/properties/properties-modal.component';
import { AlertsModalComponent } from '../../features/modals/alerts-modal/alerts-modal.component';
import { AlertActionEditorComponent } from '../../features/modals/alerts-modal/actions/alert-action-editor/alert-action-editor.component';
import { AlertRuleEditorComponent } from '../../features/modals/alerts-modal/rules/alert-rules-editor/alert-rule-editor.component';
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
import { ApiClientService, isHeadlessMode } from '../infrastructure/platform/api-client.service';
import { AppSettingsService } from '../settings/app-settings.service';

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

class MockDialogRef<R = any> {
  private readonly afterClosedSubject = new Subject<R | undefined>();

  constructor(public id: string) {}

  afterClosed(): Observable<R | undefined> {
    return this.afterClosedSubject.asObservable();
  }

  close(result?: R): void {
    this.afterClosedSubject.next(result);
    this.afterClosedSubject.complete();
  }

  backdropClick(): Observable<MouseEvent> {
    return new Subject<MouseEvent>().asObservable();
  }

  keydownEvents(): Observable<KeyboardEvent> {
    return new Subject<KeyboardEvent>().asObservable();
  }

  updatePosition(): this {
    return this;
  }

  updateSize(): this {
    return this;
  }
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
  private readonly translate = inject(TranslateService);
  private readonly apiClient = inject(ApiClientService);
  private readonly injector = inject(Injector);

  private shouldOpenStandalone(): boolean {
    if (isHeadlessMode()) {
      return false;
    }
    const appSettingsService = this.injector.get(AppSettingsService);
    const options = appSettingsService.options();
    return options ? options['general.standalone_dialogs']?.value === true : false;
  }

  private openStandaloneDialog<T, R = any>(
    dialogType: string,
    title: string,
    data: any,
    width?: number,
    height?: number
  ): MatDialogRef<T, R> {
    const label = `dialog-${dialogType}`;
    const mockRef = new MockDialogRef<R>(label);

    let url = `index.html?standalone=dialog&dialogType=${dialogType}`;
    if (data) {
      url += `&data=${encodeURIComponent(JSON.stringify(data))}`;
    }

    // Call Rust to create the window
    this.apiClient
      .invoke('new_window', {
        opts: {
          label,
          url,
          title,
          width,
          height,
        },
      })
      .catch(err => {
        console.error('Failed to open standalone dialog window:', err);
      });

    const targetWin = new Window(label);

    let resultReceived = false;
    let unlistenResult: (() => void) | undefined;
    let unlistenDestroyed: (() => void) | undefined;

    const cleanup = () => {
      if (unlistenResult) unlistenResult();
      if (unlistenDestroyed) unlistenDestroyed();
    };

    targetWin
      .listen<R>(`dialog-result-${label}`, event => {
        resultReceived = true;
        mockRef.close(event.payload);
        cleanup();
      })
      .then(u => {
        unlistenResult = u;
      });

    targetWin
      .once('tauri://destroyed', () => {
        cleanup();
        if (!resultReceived) {
          mockRef.close();
        }
      })
      .then(u => {
        unlistenDestroyed = u;
      });

    return mockRef as unknown as MatDialogRef<T, R>;
  }

  // ============================================================================
  // Remote Management Modals
  // ============================================================================

  openQuickAddRemote(): MatDialogRef<QuickAddRemoteComponent> {
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<QuickAddRemoteComponent>(
        'quick-add-remote',
        this.translate.instant('titlebar.menu.quickRemote'),
        null,
        680,
        600
      );
    }
    return this.dialog.open(QuickAddRemoteComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
    });
  }

  openRemoteConfig(
    options: RemoteConfigModalOptions = {}
  ): MatDialogRef<RemoteConfigModalComponent> {
    const data = {
      name: options.remoteName,
      remoteType: options.remoteType,
      editTarget: options.editTarget,
      existingConfig: options.existingConfig,
      initialSection: options.initialSection,
      targetProfile: options.targetProfile,
      cloneTarget: options.cloneTarget,
      autoAddProfile: options.autoAddProfile,
    };
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<RemoteConfigModalComponent>(
        'remote-config',
        this.translate.instant('titlebar.menu.detailedRemote'),
        data,
        1024,
        768
      );
    }
    return this.dialog.open(RemoteConfigModalComponent, {
      ...CONFIG_MODAL_SIZE,
      disableClose: true,
      data,
    });
  }

  // ============================================================================
  // Settings Modals
  // ============================================================================

  openLogs(remoteName: string): MatDialogRef<LogsModalComponent> {
    const data = { remoteName };
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<LogsModalComponent>(
        'logs',
        this.translate.instant('settings.logs.remoteLogs', { name: remoteName }),
        data,
        680,
        600
      );
    }
    return this.dialog.open(LogsModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data,
    });
  }

  openExport(options: ExportModalOptions = {}): MatDialogRef<ExportModalComponent> {
    const data = {
      remoteName: options.remoteName,
      defaultExportType: options.defaultExportType ?? 'FullBackup',
    };
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<ExportModalComponent>(
        'export',
        this.translate.instant('titlebar.menu.export'),
        data,
        680,
        600
      );
    }
    return this.dialog.open(ExportModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data,
    });
  }

  openBackend(): MatDialogRef<BackendModalComponent> {
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<BackendModalComponent>(
        'backend',
        this.translate.instant('settings.backend.title') || 'Backend Management',
        null,
        680,
        600
      );
    }
    return this.dialog.open(BackendModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: false,
    });
  }

  openPreferences(): MatDialogRef<PreferencesModalComponent> {
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<PreferencesModalComponent>(
        'preferences',
        this.translate.instant('settings.preferences.title'),
        null,
        680,
        600
      );
    }
    return this.dialog.open(PreferencesModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
    });
  }

  openRcloneFlags(): MatDialogRef<RcloneFlagsModalComponent> {
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<RcloneFlagsModalComponent>(
        'rclone-flags',
        this.translate.instant('titlebar.menu.flags'),
        null,
        680,
        600
      );
    }
    return this.dialog.open(RcloneFlagsModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
    });
  }

  /**
   * Open the Job Detail modal for a given job info object.
   * Uses the standard modal sizing and provides a default panelClass for styling.
   */
  openJobDetail(job: JobInfo): MatDialogRef<JobDetailModalComponent> {
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<JobDetailModalComponent>(
        'job-detail',
        this.translate.instant('settings.jobDetail.title', { id: job.jobid }),
        job,
        680,
        600
      );
    }
    return this.dialog.open(JobDetailModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: job,
    });
  }

  openProperties(options: PropertiesModalOptions): MatDialogRef<PropertiesModalComponent> {
    const data = {
      remoteName: options.remoteName,
      path: options.path,
      isLocal: options.isLocal,
      item: options.item,
      remoteType: options.remoteType,
      features: options.features,
    };
    if (this.shouldOpenStandalone()) {
      let width = 680;
      if (options.width) {
        if (options.width.endsWith('px')) {
          width = parseInt(options.width);
        } else if (options.width.endsWith('vw')) {
          width = Math.round((parseInt(options.width) / 100) * window.innerWidth);
        }
      }
      let height = 600;
      if (options.height) {
        if (options.height.endsWith('px')) {
          height = parseInt(options.height);
        } else if (options.height.endsWith('vh')) {
          height = Math.round((parseInt(options.height) / 100) * window.innerHeight);
        }
      }
      return this.openStandaloneDialog<PropertiesModalComponent>(
        'properties',
        this.translate.instant('properties.title') || 'Properties',
        data,
        width,
        height
      );
    }
    return this.dialog.open(PropertiesModalComponent, {
      data,
      height: options.height ?? '60vh',
      maxHeight: options.maxHeight ?? '800px',
      width: options.width ?? '60vw',
      maxWidth: options.maxWidth ?? '400px',
    });
  }

  openRemoteAbout(options: RemoteAboutModalOptions): MatDialogRef<RemoteAboutModalComponent> {
    const data = {
      remote: {
        displayName: options.displayName,
        normalizedName: options.normalizedName,
        type: options.type,
      },
    };
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<RemoteAboutModalComponent>(
        'remote-about',
        options.displayName,
        data,
        680,
        600
      );
    }
    return this.dialog.open(RemoteAboutModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data,
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
    const data = {
      backupPath: options.backupPath,
      analysis: options.analysis,
    };
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<RestorePreviewModalComponent>(
        'restore-preview',
        this.translate.instant('settings.restore.title') || 'Restore Backup',
        data,
        680,
        600
      );
    }
    return this.dialog.open(RestorePreviewModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data,
    });
  }

  openAlerts(): MatDialogRef<AlertsModalComponent> {
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<AlertsModalComponent>(
        'alerts',
        this.translate.instant('alerts.title') || 'Alerts & Notifications',
        null,
        1200,
        800
      );
    }
    return this.dialog.open(AlertsModalComponent, {
      width: '90vw',
      maxWidth: '1200px',
      height: '85vh',
      disableClose: false,
      panelClass: 'alerts-modal-panel',
    });
  }

  openAlertActionEditor(data?: AlertAction): MatDialogRef<AlertActionEditorComponent, AlertAction> {
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<AlertActionEditorComponent, AlertAction>(
        'alert-action-editor',
        'Alert Action Editor',
        data,
        600,
        500
      );
    }
    return this.dialog.open(AlertActionEditorComponent, {
      width: '600px',
      disableClose: false,
      data,
    });
  }

  openAlertRuleEditor(data?: AlertRule): MatDialogRef<AlertRuleEditorComponent, AlertRule> {
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<AlertRuleEditorComponent, AlertRule>(
        'alert-rule-editor',
        'Alert Rule Editor',
        data,
        600,
        500
      );
    }
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

import { Injectable, inject, Injector, signal } from '@angular/core';
import {
  MatDialog,
  MatDialogConfig,
  MatDialogRef,
  MAT_DIALOG_DATA,
} from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { Subject, Observable } from 'rxjs';
import { Window, getCurrentWindow } from '@tauri-apps/api/window';

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
  initialSection?: string;
  targetProfile?: string;
  autoAddProfile?: boolean;
  cloneFrom?: string;
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

const sanitizeLabel = (str: string): string => {
  return str.replace(/[^a-zA-Z0-9_-]/g, '-');
};

abstract class StandaloneDialogRef<R = any> {
  constructor(public id: string) {}

  abstract close(result?: R): void;

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

class MockDialogRef<R = any> extends StandaloneDialogRef<R> {
  private readonly afterClosedSubject = new Subject<R | undefined>();

  afterClosed(): Observable<R | undefined> {
    return this.afterClosedSubject.asObservable();
  }

  close(result?: R): void {
    this.afterClosedSubject.next(result);
    this.afterClosedSubject.complete();
  }
}

class ChildDialogRef<R = any> extends StandaloneDialogRef<R> {
  close(result?: R): void {
    getCurrentWindow()
      .emit(`dialog-result-${this.id}`, result)
      .then(() => {
        getCurrentWindow().close();
      })
      .catch(err => {
        console.error('Failed to emit dialog result or close window:', err);
        getCurrentWindow().close();
      });
  }
}

const componentsMap: Record<string, any> = {
  'quick-add-remote': QuickAddRemoteComponent,
  'remote-config': RemoteConfigModalComponent,
  logs: LogsModalComponent,
  export: ExportModalComponent,
  backend: BackendModalComponent,
  preferences: PreferencesModalComponent,
  'rclone-flags': RcloneFlagsModalComponent,
  'job-detail': JobDetailModalComponent,
  properties: PropertiesModalComponent,
  'remote-about': RemoteAboutModalComponent,
  'keyboard-shortcuts': KeyboardShortcutsModalComponent,
  about: AboutModalComponent,
  'restore-preview': RestorePreviewModalComponent,
  alerts: AlertsModalComponent,
  'alert-action-editor': AlertActionEditorComponent,
  'alert-rule-editor': AlertRuleEditorComponent,
};

@Injectable({
  providedIn: 'root',
})
export class ModalService {
  private readonly dialog = inject(MatDialog);
  private readonly translate = inject(TranslateService);
  private readonly apiClient = inject(ApiClientService);
  private readonly injector = inject(Injector);

  readonly isDialogStandalone = signal(false);
  readonly dialogComponent = signal<any>(null);
  dialogInjector?: Injector;

  constructor() {
    const urlParams = new URLSearchParams(window.location.search);
    const isDialog = urlParams.get('standalone') === 'dialog';
    this.isDialogStandalone.set(isDialog);
  }

  // ============================================================================
  // Standalone Host Resolution
  // ============================================================================

  resolveDialogWindow(): void {
    const urlParams = new URLSearchParams(window.location.search);
    const dialogType = urlParams.get('dialogType');

    const componentClass = dialogType ? componentsMap[dialogType] : null;
    if (!componentClass) {
      console.error(`[ModalService] Standalone dialog component not found for type: ${dialogType}`);
      return;
    }

    this.dialogComponent.set(componentClass);

    let parsedData: any = null;
    const currentWindowLabel = getCurrentWindow().label;
    const rawData = urlParams.get('dialogData');
    if (rawData) {
      try {
        parsedData = JSON.parse(decodeURIComponent(rawData));
      } catch (e) {
        console.error('[ModalService] Failed to parse URL data:', e);
      }
    }

    const mockRef = new ChildDialogRef(currentWindowLabel);

    this.dialogInjector = Injector.create({
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: parsedData },
        { provide: MatDialogRef, useValue: mockRef },
      ],
      parent: this.injector,
    });
  }

  // ============================================================================
  // Standalone Guest Helpers
  // ============================================================================

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
    height?: number,
    uniqueSuffix?: string
  ): MatDialogRef<T, R> {
    const suffix = uniqueSuffix ? `-${sanitizeLabel(uniqueSuffix)}` : '';
    const label = `dialog-${dialogType}${suffix}`;
    const mockRef = new MockDialogRef<R>(label);

    const encodedData = data ? encodeURIComponent(JSON.stringify(data)) : '';
    const url = `index.html?standalone=dialog&dialogType=${dialogType}${encodedData ? `&dialogData=${encodedData}` : ''}`;

    this.setupStandaloneWindow(label, url, title, width, height, mockRef);

    return mockRef as unknown as MatDialogRef<T, R>;
  }

  private async setupStandaloneWindow<R>(
    label: string,
    url: string,
    title: string,
    width: number | undefined,
    height: number | undefined,
    mockRef: MockDialogRef<R>
  ): Promise<void> {
    let created: boolean;
    try {
      created = await this.apiClient.invoke<boolean>('new_window', {
        opts: { label, url, title, width, height },
      });
    } catch (err) {
      console.error('Failed to open standalone dialog window:', err);
      return;
    }

    if (!created) {
      return;
    }

    const targetWin = new Window(label);
    let resultReceived = false;

    let unlistenResult: (() => void) | undefined;
    let unlistenDestroyed: (() => void) | undefined;

    const cleanup = (): void => {
      if (unlistenResult) unlistenResult();
      if (unlistenDestroyed) unlistenDestroyed();
    };

    try {
      unlistenResult = await targetWin.listen<R>(`dialog-result-${label}`, event => {
        resultReceived = true;
        mockRef.close(event.payload);
        cleanup();
      });

      unlistenDestroyed = await targetWin.once('tauri://destroyed', () => {
        cleanup();
        if (!resultReceived) {
          mockRef.close();
        }
      });
    } catch (err) {
      console.error('[ModalService] Failed to set up standalone window event listeners:', err);
      cleanup();
    }
  }

  // ============================================================================
  // Standalone Modals (Multi-Instance)
  // ============================================================================

  openRemoteConfig(
    options: RemoteConfigModalOptions = {}
  ): MatDialogRef<RemoteConfigModalComponent> {
    const data = {
      name: options.remoteName,
      remoteType: options.remoteType,
      editTarget: options.editTarget,
      initialSection: options.initialSection,
      targetProfile: options.targetProfile,
      autoAddProfile: options.autoAddProfile,
      cloneFrom: options.cloneFrom,
    };
    if (this.shouldOpenStandalone()) {
      const suffixParts: string[] = [];
      if (options.remoteName) suffixParts.push(options.remoteName);
      if (options.targetProfile) suffixParts.push(options.targetProfile);
      if (options.editTarget) suffixParts.push(options.editTarget);
      const uniqueSuffix = suffixParts.length > 0 ? suffixParts.join('-') : 'new';

      return this.openStandaloneDialog<RemoteConfigModalComponent>(
        'remote-config',
        this.translate.instant('titlebar.menu.detailedRemote'),
        data,
        1024,
        768,
        uniqueSuffix
      );
    }
    return this.dialog.open(RemoteConfigModalComponent, {
      ...CONFIG_MODAL_SIZE,
      disableClose: true,
      data,
    });
  }

  openLogs(remoteName: string): MatDialogRef<LogsModalComponent> {
    const data = { remoteName };
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<LogsModalComponent>(
        'logs',
        this.translate.instant('modals.logs.remoteLogs', { name: remoteName }),
        data,
        680,
        600,
        remoteName
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
        600,
        options.remoteName || 'full'
      );
    }
    return this.dialog.open(ExportModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data,
    });
  }

  openJobDetail(job: JobInfo): MatDialogRef<JobDetailModalComponent> {
    const data = { jobid: job.jobid, execute_id: job.execute_id };
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<JobDetailModalComponent>(
        'job-detail',
        this.translate.instant('modals.jobDetail.title', { id: job.jobid }),
        data,
        680,
        600,
        job.jobid.toString()
      );
    }
    return this.dialog.open(JobDetailModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data,
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
        this.translate.instant('backup.restore.title') || 'Restore Backup',
        data,
        680,
        600,
        options.backupPath
      );
    }
    return this.dialog.open(RestorePreviewModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data,
    });
  }

  // ============================================================================
  // Standalone Modals (Single-Instance)
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

  openBackend(): MatDialogRef<BackendModalComponent> {
    if (this.shouldOpenStandalone()) {
      return this.openStandaloneDialog<BackendModalComponent>(
        'backend',
        this.translate.instant('modals.backend.title') || 'Backend Management',
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
        this.translate.instant('modals.preferences.title'),
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

  // ============================================================================
  // Standard-Only Modals (Non-Standalone)
  // ============================================================================

  openProperties(options: PropertiesModalOptions): MatDialogRef<PropertiesModalComponent> {
    const data = {
      remoteName: options.remoteName,
      path: options.path,
      isLocal: options.isLocal,
      item: options.item,
      remoteType: options.remoteType,
      features: options.features,
    };
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
    return this.dialog.open(RemoteAboutModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data,
    });
  }

  openAlertActionEditor(actionId?: string): MatDialogRef<AlertActionEditorComponent, AlertAction> {
    return this.dialog.open(AlertActionEditorComponent, {
      width: '600px',
      disableClose: false,
      data: { actionId },
    });
  }

  openAlertRuleEditor(ruleId?: string): MatDialogRef<AlertRuleEditorComponent, AlertRule> {
    return this.dialog.open(AlertRuleEditorComponent, {
      width: '600px',
      disableClose: true,
      data: { ruleId },
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
  // Utilities
  // ============================================================================

  animatedClose<T, R = unknown>(
    dialogRef: MatDialogRef<T>,
    result?: R,
    animationDuration = 200
  ): void {
    const isMobile = window.innerWidth <= 450;
    if (isMobile) {
      const dialogContainer = document.getElementById(dialogRef.id);
      if (dialogContainer) {
        dialogContainer.classList.add('closing');
        setTimeout(() => {
          dialogRef.close(result);
        }, animationDuration);
      } else {
        dialogRef.close(result);
      }
    } else {
      dialogRef.close(result);
    }
  }
}

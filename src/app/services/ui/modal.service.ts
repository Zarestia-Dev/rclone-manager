import { Injectable, inject, Injector, signal, Type } from '@angular/core';
import { MatDialog, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { Subject, Observable, from, switchMap } from 'rxjs';
import { Window, getCurrentWindow } from '@tauri-apps/api/window';

import {
  RemoteFeatures,
  STANDARD_MODAL_SIZE,
  CONFIG_MODAL_SIZE,
  ABOUT_MODAL_SIZE,
  BackupAnalysis,
} from '@app/types';
import { JobInfo } from '../../shared/types/jobs';
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

const sanitizeLabel = (str: string): string => str.replace(/[^a-zA-Z0-9_-]/g, '-');

interface StandaloneOpts {
  type: string;
  title: string;
  data?: any;
  width?: number;
  height?: number;
  suffix?: string;
}

class AsyncDialogRef<R = any> {
  constructor(private readonly promise: Promise<MatDialogRef<any, R>>) {}

  afterClosed(): Observable<R | undefined> {
    return from(this.promise).pipe(switchMap(ref => ref.afterClosed()));
  }

  close(result?: R): void {
    this.promise.then(ref => ref.close(result));
  }
}

class ChildWindowRef<R = any> {
  constructor(private readonly windowLabel: string) {}

  close(result?: R): void {
    const win = getCurrentWindow();
    win
      .emit(`dialog-result-${this.windowLabel}`, result)
      .then(() => win.close())
      .catch(() => win.close());
  }
}

class StandaloneWindowRef<R = any> {
  private readonly closed$ = new Subject<R | undefined>();

  afterClosed(): Observable<R | undefined> {
    return this.closed$.asObservable();
  }

  resolve(result?: R): void {
    this.closed$.next(result);
    this.closed$.complete();
  }
}

@Injectable({ providedIn: 'root' })
export class ModalService {
  private readonly dialog = inject(MatDialog);
  private readonly translate = inject(TranslateService);
  private readonly apiClient = inject(ApiClientService);
  private readonly appSettings = inject(AppSettingsService);
  private readonly injector = inject(Injector);

  private readonly _isDialogStandalone = signal<boolean>(false);
  readonly isDialogStandalone = this._isDialogStandalone.asReadonly();

  private readonly _dialogComponent = signal<Type<any> | null>(null);
  readonly dialogComponent = this._dialogComponent.asReadonly();

  dialogInjector?: Injector;

  private readonly loaders: Record<string, () => Promise<Type<any>>> = {
    'quick-add-remote': () =>
      import('../../features/modals/remote-management/quick-add-remote/quick-add-remote.component').then(
        m => m.QuickAddRemoteComponent
      ),
    'remote-config': () =>
      import('../../features/modals/remote-management/remote-config-modal/remote-config-modal.component').then(
        m => m.RemoteConfigModalComponent
      ),
    logs: () =>
      import('../../features/modals/settings/logs-modal/logs-modal.component').then(
        m => m.LogsModalComponent
      ),
    export: () =>
      import('../../features/modals/settings/export-modal/export-modal.component').then(
        m => m.ExportModalComponent
      ),
    backend: () =>
      import('../../features/modals/settings/backend-modal/backend-modal.component').then(
        m => m.BackendModalComponent
      ),
    preferences: () =>
      import('../../features/modals/settings/preferences-modal/preferences-modal.component').then(
        m => m.PreferencesModalComponent
      ),
    'rclone-flags': () =>
      import('../../features/modals/settings/rclone-flags-modal/rclone-flags-modal.component').then(
        m => m.RcloneFlagsModalComponent
      ),
    'job-detail': () =>
      import('../../features/modals/job-detail-modal/job-detail-modal.component').then(
        m => m.JobDetailModalComponent
      ),
    properties: () =>
      import('../../features/modals/properties/properties-modal.component').then(
        m => m.PropertiesModalComponent
      ),
    'remote-about': () =>
      import('../../features/modals/remote/remote-about-modal.component').then(
        m => m.RemoteAboutModalComponent
      ),
    'keyboard-shortcuts': () =>
      import('../../features/modals/settings/keyboard-shortcuts-modal/keyboard-shortcuts-modal.component').then(
        m => m.KeyboardShortcutsModalComponent
      ),
    about: () =>
      import('../../features/modals/settings/about-modal/about-modal.component').then(
        m => m.AboutModalComponent
      ),
    'restore-preview': () =>
      import('../../features/modals/settings/restore-preview-modal/restore-preview-modal.component').then(
        m => m.RestorePreviewModalComponent
      ),
    alerts: () =>
      import('../../features/modals/alerts-modal/alerts-modal.component').then(
        m => m.AlertsModalComponent
      ),
  };

  constructor() {
    this._isDialogStandalone.set(
      new URLSearchParams(window.location.search).get('standalone') === 'dialog'
    );
  }

  async resolveDialogWindow(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const dialogType = params.get('dialogType') ?? '';
    const loader = this.loaders[dialogType];

    if (!loader) {
      console.error(`[ModalService] Unknown standalone dialog type: "${dialogType}"`);
      return;
    }

    const component = await loader();
    this._dialogComponent.set(component);

    let data: any = null;
    const raw = params.get('dialogData');
    if (raw) {
      try {
        data = JSON.parse(decodeURIComponent(raw));
      } catch (e) {
        console.error('[ModalService] Failed to parse dialogData:', e);
      }
    }

    const windowLabel = getCurrentWindow().label;
    this.dialogInjector = Injector.create({
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: new ChildWindowRef(windowLabel) },
      ],
      parent: this.injector,
    });
  }

  private get standaloneEnabled(): boolean {
    return (
      !isHeadlessMode() &&
      this.appSettings.options()?.['general.standalone_dialogs']?.value === true
    );
  }

  private openModal(
    importAndOpen: () => Promise<MatDialogRef<any>>,
    standalone?: StandaloneOpts
  ): MatDialogRef<any> {
    if (standalone && this.standaloneEnabled) {
      return this.spawnStandaloneWindow(standalone) as unknown as MatDialogRef<any>;
    }
    return new AsyncDialogRef(importAndOpen()) as unknown as MatDialogRef<any>;
  }

  private spawnStandaloneWindow<R>(opts: StandaloneOpts): StandaloneWindowRef<R> {
    const suffix = opts.suffix ? `-${sanitizeLabel(opts.suffix)}` : '';
    const label = `dialog-${opts.type}${suffix}`;
    const ref = new StandaloneWindowRef<R>();

    const encoded = opts.data ? encodeURIComponent(JSON.stringify(opts.data)) : '';
    const url = `index.html?standalone=dialog&dialogType=${opts.type}${encoded ? `&dialogData=${encoded}` : ''}`;

    this.openWindowAndBind(label, url, opts.title, opts.width, opts.height, ref);
    return ref;
  }

  private async openWindowAndBind<R>(
    label: string,
    url: string,
    title: string,
    width: number | undefined,
    height: number | undefined,
    ref: StandaloneWindowRef<R>
  ): Promise<void> {
    let created: boolean;
    try {
      created = await this.apiClient.invoke<boolean>('new_window', {
        opts: { label, url, title, width, height },
      });
    } catch (err) {
      console.error('[ModalService] Failed to open standalone window:', err);
      return;
    }

    if (!created) return;

    const win = new Window(label);
    let resultReceived = false;
    let unlistenResult: (() => void) | undefined;
    let unlistenDestroyed: (() => void) | undefined;

    const cleanup = (): void => {
      unlistenResult?.();
      unlistenDestroyed?.();
    };

    try {
      unlistenResult = await win.listen<R>(`dialog-result-${label}`, ({ payload }) => {
        resultReceived = true;
        ref.resolve(payload);
        cleanup();
      });

      unlistenDestroyed = await win.once('tauri://destroyed', () => {
        cleanup();
        if (!resultReceived) ref.resolve();
      });
    } catch (err) {
      console.error('[ModalService] Failed to bind standalone window listeners:', err);
      cleanup();
    }
  }

  openRemoteConfig(options: RemoteConfigModalOptions = {}): MatDialogRef<any> {
    const data = {
      name: options.remoteName,
      remoteType: options.remoteType,
      editTarget: options.editTarget,
      initialSection: options.initialSection,
      targetProfile: options.targetProfile,
      autoAddProfile: options.autoAddProfile,
      cloneFrom: options.cloneFrom,
    };
    const suffix =
      [options.remoteName, options.targetProfile, options.editTarget].filter(Boolean).join('-') ||
      'new';
    return this.openModal(
      () =>
        import('../../features/modals/remote-management/remote-config-modal/remote-config-modal.component').then(
          m =>
            this.dialog.open(m.RemoteConfigModalComponent, {
              ...CONFIG_MODAL_SIZE,
              disableClose: true,
              data,
            })
        ),
      {
        type: 'remote-config',
        title: this.translate.instant('titlebar.menu.detailedRemote'),
        data,
        width: 1024,
        height: 768,
        suffix,
      }
    );
  }

  openLogs(remoteName: string): MatDialogRef<any> {
    const data = { remoteName };
    return this.openModal(
      () =>
        import('../../features/modals/settings/logs-modal/logs-modal.component').then(m =>
          this.dialog.open(m.LogsModalComponent, {
            ...STANDARD_MODAL_SIZE,
            disableClose: true,
            data,
          })
        ),
      {
        type: 'logs',
        title: this.translate.instant('modals.logs.remoteLogs', { name: remoteName }),
        data,
        width: 680,
        height: 600,
        suffix: remoteName,
      }
    );
  }

  openExport(options: ExportModalOptions = {}): MatDialogRef<any> {
    const data = {
      remoteName: options.remoteName,
      defaultExportType: options.defaultExportType ?? 'FullBackup',
    };
    return this.openModal(
      () =>
        import('../../features/modals/settings/export-modal/export-modal.component').then(m =>
          this.dialog.open(m.ExportModalComponent, {
            ...STANDARD_MODAL_SIZE,
            disableClose: true,
            data,
          })
        ),
      {
        type: 'export',
        title: this.translate.instant('titlebar.menu.export'),
        data,
        width: 680,
        height: 600,
        suffix: options.remoteName ?? 'full',
      }
    );
  }

  openJobDetail(job: JobInfo): MatDialogRef<any> {
    const data = { jobid: job.jobid, execute_id: job.execute_id };
    return this.openModal(
      () =>
        import('../../features/modals/job-detail-modal/job-detail-modal.component').then(m =>
          this.dialog.open(m.JobDetailModalComponent, {
            ...STANDARD_MODAL_SIZE,
            disableClose: true,
            data,
          })
        ),
      {
        type: 'job-detail',
        title: this.translate.instant('modals.jobDetail.title', { id: job.jobid }),
        data,
        width: 680,
        height: 600,
        suffix: String(job.jobid),
      }
    );
  }

  openRestorePreview(options: RestorePreviewOptions): MatDialogRef<any> {
    const data = { backupPath: options.backupPath, analysis: options.analysis };
    return this.openModal(
      () =>
        import('../../features/modals/settings/restore-preview-modal/restore-preview-modal.component').then(
          m =>
            this.dialog.open(m.RestorePreviewModalComponent, {
              ...STANDARD_MODAL_SIZE,
              disableClose: true,
              data,
            })
        ),
      {
        type: 'restore-preview',
        title: this.translate.instant('backup.restore.title') || 'Restore Backup',
        data,
        width: 680,
        height: 600,
        suffix: options.backupPath,
      }
    );
  }

  openQuickAddRemote(): MatDialogRef<any> {
    return this.openModal(
      () =>
        import('../../features/modals/remote-management/quick-add-remote/quick-add-remote.component').then(
          m =>
            this.dialog.open(m.QuickAddRemoteComponent, {
              ...STANDARD_MODAL_SIZE,
              disableClose: true,
            })
        ),
      {
        type: 'quick-add-remote',
        title: this.translate.instant('titlebar.menu.quickRemote'),
        width: 680,
        height: 600,
      }
    );
  }

  openBackend(): MatDialogRef<any> {
    return this.openModal(
      () =>
        import('../../features/modals/settings/backend-modal/backend-modal.component').then(m =>
          this.dialog.open(m.BackendModalComponent, { ...STANDARD_MODAL_SIZE, disableClose: false })
        ),
      {
        type: 'backend',
        title: this.translate.instant('modals.backend.title') || 'Backend Management',
        width: 680,
        height: 600,
      }
    );
  }

  openPreferences(): MatDialogRef<any> {
    return this.openModal(
      () =>
        import('../../features/modals/settings/preferences-modal/preferences-modal.component').then(
          m =>
            this.dialog.open(m.PreferencesModalComponent, {
              ...STANDARD_MODAL_SIZE,
              disableClose: true,
            })
        ),
      {
        type: 'preferences',
        title: this.translate.instant('modals.preferences.title'),
        width: 680,
        height: 600,
      }
    );
  }

  openRcloneFlags(): MatDialogRef<any> {
    return this.openModal(
      () =>
        import('../../features/modals/settings/rclone-flags-modal/rclone-flags-modal.component').then(
          m =>
            this.dialog.open(m.RcloneFlagsModalComponent, {
              ...STANDARD_MODAL_SIZE,
              disableClose: true,
            })
        ),
      {
        type: 'rclone-flags',
        title: this.translate.instant('titlebar.menu.flags'),
        width: 680,
        height: 600,
      }
    );
  }

  openAlerts(): MatDialogRef<any> {
    return this.openModal(
      () =>
        import('../../features/modals/alerts-modal/alerts-modal.component').then(m =>
          this.dialog.open(m.AlertsModalComponent, {
            width: '90vw',
            maxWidth: '1200px',
            height: '85vh',
            disableClose: false,
            panelClass: 'alerts-modal-panel',
          })
        ),
      {
        type: 'alerts',
        title: this.translate.instant('alerts.title') || 'Alerts & Notifications',
        width: 1200,
        height: 800,
      }
    );
  }

  openProperties(options: PropertiesModalOptions): MatDialogRef<any> {
    const data = {
      remoteName: options.remoteName,
      path: options.path,
      isLocal: options.isLocal,
      item: options.item,
      remoteType: options.remoteType,
      features: options.features,
    };
    return new AsyncDialogRef(
      import('../../features/modals/properties/properties-modal.component').then(m =>
        this.dialog.open(m.PropertiesModalComponent, {
          data,
          height: options.height ?? '60vh',
          maxHeight: options.maxHeight ?? '800px',
          width: options.width ?? '60vw',
          maxWidth: options.maxWidth ?? '400px',
        })
      )
    ) as unknown as MatDialogRef<any>;
  }

  openRemoteAbout(options: RemoteAboutModalOptions): MatDialogRef<any> {
    const data = {
      remote: {
        displayName: options.displayName,
        normalizedName: options.normalizedName,
        type: options.type,
      },
    };
    return new AsyncDialogRef(
      import('../../features/modals/remote/remote-about-modal.component').then(m =>
        this.dialog.open(m.RemoteAboutModalComponent, {
          ...STANDARD_MODAL_SIZE,
          disableClose: true,
          data,
        })
      )
    ) as unknown as MatDialogRef<any>;
  }

  openKeyboardShortcuts(data?: { nautilus?: boolean }): MatDialogRef<any> {
    return new AsyncDialogRef(
      import('../../features/modals/settings/keyboard-shortcuts-modal/keyboard-shortcuts-modal.component').then(
        m =>
          this.dialog.open(m.KeyboardShortcutsModalComponent, {
            ...STANDARD_MODAL_SIZE,
            disableClose: true,
            data,
          })
      )
    ) as unknown as MatDialogRef<any>;
  }

  openAbout(): MatDialogRef<any> {
    return new AsyncDialogRef(
      import('../../features/modals/settings/about-modal/about-modal.component').then(m =>
        this.dialog.open(m.AboutModalComponent, { ...ABOUT_MODAL_SIZE, disableClose: true })
      )
    ) as unknown as MatDialogRef<any>;
  }

  openArchiveCreate(data: { items: any[]; defaultName: string }): MatDialogRef<any> {
    return new AsyncDialogRef(
      import('../../shared/modals/archive-create-modal/archive-create-modal.component').then(m =>
        this.dialog.open(m.ArchiveCreateModalComponent, {
          width: '450px',
          disableClose: true,
          data,
        })
      )
    ) as unknown as MatDialogRef<any>;
  }
}

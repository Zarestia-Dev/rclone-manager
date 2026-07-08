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
  JobInfo,
} from '@app/types';
import {
  ApiClientService,
  isHeadlessMode,
  isMobile,
} from '../infrastructure/platform/api-client.service';
import { AppSettingsService } from '../settings/app-settings.service';

const originalClose = MatDialogRef.prototype.close;
MatDialogRef.prototype.close = function (this: MatDialogRef<any>, dialogResult?: any): void {
  const container = this.id ? document.getElementById(this.id) : null;
  const overlayElement = container?.closest('.cdk-overlay-pane');

  if (overlayElement?.classList.contains('mobile-sheet-dialog') && window.innerWidth <= 450) {
    if (container) {
      if (container.classList.contains('closing')) {
        return;
      }
      container.classList.add('closing');
    }
    const backdrop = overlayElement.parentElement?.querySelector('.cdk-overlay-backdrop');
    if (backdrop) {
      backdrop.classList.add('closing');
    }
    setTimeout(() => {
      originalClose.call(this, dialogResult);
    }, 200);
  } else {
    originalClose.call(this, dialogResult);
  }
};

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
      .catch(console.error)
      .finally(() => win.close());
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

  readonly isDialogStandalone = signal<boolean>(
    new URLSearchParams(window.location.search).get('standalone') === 'dialog'
  ).asReadonly();

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
    'archive-create': () =>
      import('../../shared/modals/archive-create-modal/archive-create-modal.component').then(
        m => m.ArchiveCreateModalComponent
      ),
  };

  async resolveDialogWindow(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const dialogType = params.get('dialogType') ?? '';
    const loader = this.loaders[dialogType];

    if (!loader) {
      console.error(`[ModalService] Unknown standalone dialog type: "${dialogType}"`);
      return;
    }

    this._dialogComponent.set(await loader());

    let data: any = null;
    const raw = params.get('dialogData');
    if (raw) {
      try {
        data = JSON.parse(decodeURIComponent(raw));
      } catch (e) {
        console.error('[ModalService] Failed to parse dialogData:', e);
      }
    }

    this.dialogInjector = Injector.create({
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: new ChildWindowRef(getCurrentWindow().label) },
      ],
      parent: this.injector,
    });
  }

  private get standaloneEnabled(): boolean {
    return (
      (!isHeadlessMode() || !isMobile()) &&
      this.appSettings.options()?.['general.standalone_dialogs']?.value === true
    );
  }

  private openModal(
    type: string,
    config: any,
    standalone?: Omit<StandaloneOpts, 'type' | 'data'>
  ): any {
    if (standalone && this.standaloneEnabled) {
      return this.spawnStandaloneWindow({ type, data: config.data, ...standalone });
    }
    if (config.height && !config.panelClass) {
      config.panelClass = 'mobile-sheet-dialog';
    }
    const dialogPromise = this.loaders[type]().then(comp => this.dialog.open(comp, config));
    return new AsyncDialogRef(dialogPromise);
  }

  private spawnStandaloneWindow(opts: StandaloneOpts): StandaloneWindowRef {
    const suffix = opts.suffix ? `-${sanitizeLabel(opts.suffix)}` : '';
    const label = `dialog-${opts.type}${suffix}`;
    const ref = new StandaloneWindowRef();

    const encoded = opts.data ? encodeURIComponent(JSON.stringify(opts.data)) : '';
    const url = `index.html?standalone=dialog&dialogType=${opts.type}${encoded ? `&dialogData=${encoded}` : ''}`;

    this.openWindowAndBind(label, url, opts.title, opts.width, opts.height, ref);
    return ref;
  }

  private async openWindowAndBind(
    label: string,
    url: string,
    title: string,
    width: number | undefined,
    height: number | undefined,
    ref: StandaloneWindowRef
  ): Promise<void> {
    try {
      const created = await this.apiClient.invoke<boolean>('new_window', {
        opts: { label, url, title, width, height },
      });
      if (!created) return;

      const win = new Window(label);
      let resultReceived = false;

      const unlistenResult = await win.listen(`dialog-result-${label}`, ({ payload }) => {
        resultReceived = true;
        ref.resolve(payload);
        unlistenResult();
        unlistenDestroyed();
      });

      const unlistenDestroyed = await win.once('tauri://destroyed', () => {
        unlistenResult();
        unlistenDestroyed();
        if (!resultReceived) ref.resolve();
      });
    } catch (err) {
      console.error('[ModalService] Failed to bind standalone window:', err);
    }
  }

  openRemoteConfig(options: RemoteConfigModalOptions = {}): any {
    const data = {
      name: options.remoteName,
      remoteType: options.remoteType,
      editTarget: options.editTarget,
      initialSection: options.initialSection,
      targetProfile: options.targetProfile,
      autoAddProfile: options.autoAddProfile,
      cloneFrom: options.cloneFrom,
    };
    return this.openModal(
      'remote-config',
      { ...CONFIG_MODAL_SIZE, disableClose: true, data },
      {
        title: this.translate.instant('titlebar.menu.detailedRemote'),
        width: 1024,
        height: 768,
        suffix:
          [options.remoteName, options.targetProfile, options.editTarget]
            .filter(Boolean)
            .join('-') || 'new',
      }
    );
  }

  openLogs(remoteName: string): any {
    const data = { remoteName };
    return this.openModal(
      'logs',
      { ...STANDARD_MODAL_SIZE, disableClose: true, data },
      {
        title: this.translate.instant('modals.logs.remoteLogs', { name: remoteName }),
        width: 680,
        height: 600,
        suffix: remoteName,
      }
    );
  }

  openExport(options: ExportModalOptions = {}): any {
    const data = {
      remoteName: options.remoteName,
      defaultExportType: options.defaultExportType ?? 'FullBackup',
    };
    return this.openModal(
      'export',
      { ...STANDARD_MODAL_SIZE, disableClose: true, data },
      {
        title: this.translate.instant('titlebar.menu.export'),
        width: 680,
        height: 600,
        suffix: options.remoteName ?? 'full',
      }
    );
  }

  openJobDetail(job: JobInfo): any {
    const data = { ...job };
    return this.openModal(
      'job-detail',
      { ...STANDARD_MODAL_SIZE, disableClose: true, data },
      {
        title: this.translate.instant('modals.jobDetail.title', { id: job.jobid }),
        width: 680,
        height: 600,
        suffix: String(job.jobid),
      }
    );
  }

  openRestorePreview(options: RestorePreviewOptions): any {
    const data = { backupPath: options.backupPath, analysis: options.analysis };
    return this.openModal(
      'restore-preview',
      { ...STANDARD_MODAL_SIZE, disableClose: true, data },
      {
        title: this.translate.instant('backup.restore.title') || 'Restore Backup',
        width: 680,
        height: 600,
        suffix: options.backupPath,
      }
    );
  }

  openQuickAddRemote(): any {
    return this.openModal(
      'quick-add-remote',
      { ...STANDARD_MODAL_SIZE, disableClose: true },
      {
        title: this.translate.instant('titlebar.menu.quickRemote'),
        width: 680,
        height: 600,
      }
    );
  }

  openBackend(): any {
    return this.openModal(
      'backend',
      { ...STANDARD_MODAL_SIZE, disableClose: false },
      {
        title: this.translate.instant('modals.backend.title') || 'Backend Management',
        width: 680,
        height: 600,
      }
    );
  }

  openPreferences(): any {
    return this.openModal(
      'preferences',
      { ...STANDARD_MODAL_SIZE, disableClose: true },
      {
        title: this.translate.instant('modals.preferences.title'),
        width: 680,
        height: 600,
      }
    );
  }

  openRcloneFlags(): any {
    return this.openModal(
      'rclone-flags',
      { ...STANDARD_MODAL_SIZE, disableClose: true },
      {
        title: this.translate.instant('titlebar.menu.flags'),
        width: 680,
        height: 600,
      }
    );
  }

  openAlerts(): any {
    return this.openModal(
      'alerts',
      {
        width: '90vw',
        maxWidth: '1200px',
        height: '85vh',
        disableClose: false,
      },
      {
        title: this.translate.instant('alerts.title') || 'Alerts & Notifications',
        width: 1200,
        height: 800,
      }
    );
  }

  openProperties(options: PropertiesModalOptions): any {
    return this.openModal('properties', {
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

  openRemoteAbout(options: RemoteAboutModalOptions): any {
    return this.openModal('remote-about', {
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

  openKeyboardShortcuts(data?: { nautilus?: boolean }): any {
    return this.openModal('keyboard-shortcuts', {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data,
    });
  }

  openAbout(): any {
    return this.openModal('about', { ...ABOUT_MODAL_SIZE, disableClose: true });
  }

  openArchiveCreate(data: { items: any[]; defaultName: string }): any {
    return this.openModal('archive-create', {
      width: '450px',
      height: '600px',
      disableClose: true,
      data,
    });
  }
}

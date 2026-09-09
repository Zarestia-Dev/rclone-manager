import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import {
  OpenInFilesEvent,
  QuickRun,
  QuickRunConfig,
  Remote,
  StartJobEvent,
  StopJobEvent,
} from '@app/types';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { AppDetailComponent } from 'src/app/features/components/dashboard/app-detail/app-detail.component';
import { GeneralDetailComponent } from 'src/app/features/components/dashboard/general-detail/general-detail.component';
import { QuickRunOverviewComponent } from '../quick-run-overview/quick-run-overview.component';

/**
 * Main detail / editor panel view for the Quick Run feature in Flow.
 */
@Component({
  selector: 'app-quick-run-workspace',
  imports: [
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
    MatCheckboxModule,
    CdkMenuModule,
    TranslatePipe,
    AppDetailComponent,
    GeneralDetailComponent,
    QuickRunOverviewComponent,
  ],
  templateUrl: './quick-run-workspace.component.html',
  styleUrl: './quick-run-workspace.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuickRunWorkspaceComponent {
  private readonly quickRunService = inject(QuickRunService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly uiStateService = inject(UiStateService);
  private readonly modalService = inject(ModalService);
  private readonly notificationService = inject(NotificationService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly translate = inject(TranslateService);

  readonly quickRuns = this.quickRunService.quickRuns;
  readonly selected = this.quickRunService.selected;
  readonly selectedRemote = this.uiStateService.selectedRemote;

  isShowOnTray(qr: QuickRun): boolean {
    return qr.config?.app?.showOnTray ?? true;
  }

  async toggleShowOnTray(qr: QuickRun, checked: boolean): Promise<void> {
    const updatedConfig: QuickRunConfig = {
      ...qr.config,
      app: {
        ...qr.config.app,
        showOnTray: checked,
      },
    };
    await this.quickRunService.save({
      id: qr.id,
      name: qr.name,
      description: qr.description,
      operationType: qr.operationType,
      remoteName: qr.remoteName,
      config: updatedConfig,
    });
  }

  editQuickRun(id: string): void {
    const qr = this.quickRuns().find(q => q.id === id);
    if (qr) this.quickRunService.openEditor(qr);
  }

  openLogsModal(remoteName: string): void {
    this.modalService.openLogs(remoteName);
  }

  openBackendModal(): void {
    this.modalService.openBackend();
  }

  openRemoteDetail(remoteName: string): void {
    const cleanName = remoteName.replace(/:$/, '');
    const remote = this.remoteFacade
      .orderedRemotes()
      .find(r => r.name === remoteName || r.name === cleanName);
    if (remote) {
      this.quickRunService.select(null);
      this.uiStateService.setSelectedRemote(remote);
    }
  }

  onSelectQuickRun(qr: QuickRun): void {
    this.uiStateService.resetSelectedRemote();
    this.quickRunService.select(qr.id);
  }

  startQuickRun(id: string): void {
    void this.quickRunService.start(id);
  }

  stopQuickRun(id: string): void {
    void this.quickRunService.stop(id);
  }

  duplicateQuickRun(id: string): void {
    this.quickRunService.duplicate(id);
  }

  removeQuickRun(id: string): void {
    void this.quickRunService.remove(id);
  }

  async openInFiles(event: OpenInFilesEvent): Promise<void> {
    try {
      await this.remoteFacade.openRemoteInFiles(
        event.remoteName,
        event.path,
        event.profileName,
        event.operationType
      );
    } catch (error) {
      console.error('Failed to open path in files:', error);
    }
  }

  onStartRemoteJob(event: StartJobEvent): void {
    void this.remoteFacade.startJob(event.remoteName, event.type, event.profileName, 'dashboard');
  }

  onStopRemoteJob(event: StopJobEvent): void {
    void this.remoteFacade.stopJob(event.remoteName, event.type, event.serveId, event.profileName);
  }

  onDeleteRemoteJob(jobId: number): void {
    void this.remoteFacade.deleteJob(jobId);
  }

  onRetryDiskUsage(): void {
    const remote = this.selectedRemote();
    if (remote) {
      void this.remoteFacade.getCachedOrFetchDiskUsage(
        remote.name,
        undefined,
        'dashboard',
        undefined,
        true
      );
    }
  }

  onOpenRemoteConfig(editTarget?: string): void {
    const remote = this.selectedRemote();
    this.modalService.openRemoteConfig({
      remoteName: remote?.name,
      editTarget,
    });
  }

  // ── Remote action helpers ──────────────────────────────────────────────────
  getTargetRemote(remoteName: string): Remote | undefined {
    const cleanName = remoteName.replace(/:$/, '');
    return this.remoteFacade
      .orderedRemotes()
      .find(r => r.name === remoteName || r.name === cleanName);
  }

  openRemoteAbout(remote: Remote): void {
    this.remoteFacade.openRemoteAbout(remote);
  }

  canEmptyTrash(remote: Remote): boolean {
    return this.remoteFacade.canEmptyTrash(remote);
  }

  async emptyTrash(remote: Remote): Promise<void> {
    await this.remoteFacade.emptyTrash(remote, 'flow');
  }

  async cloneRemote(remoteName: string): Promise<void> {
    if (!remoteName) return;
    try {
      await this.remoteFacade.cloneRemote(remoteName);
    } catch (error) {
      console.error('Clone remote failed:', error);
      this.notificationService.showError(error);
    }
  }

  openExportModal(remoteName: string): void {
    this.modalService.openExport({ remoteName });
  }

  async resetRemoteSettings(remoteName: string): Promise<void> {
    if (!remoteName) return;
    const confirmed = await this.notificationService.confirmModal(
      this.translate.instant('home.resetRemote.title'),
      this.translate.instant('home.resetRemote.message', { name: remoteName }),
      'common.yes',
      'common.no',
      { icon: 'rotate-right', color: 'warn' }
    );
    if (!confirmed) return;
    try {
      await this.appSettingsService.resetRemoteSettings(remoteName);
    } catch (error) {
      console.error('Reset remote settings failed:', error);
      this.notificationService.showError(error);
    }
  }

  async deleteRemote(remoteName: string): Promise<void> {
    if (!remoteName) return;
    const dialogRef = this.modalService.openDeleteRemote<boolean>(remoteName);
    const confirmed = await firstValueFrom(dialogRef.afterClosed());
    if (!confirmed) return;
    try {
      await this.remoteFacade.deleteRemote(remoteName);
      if (this.selectedRemote()?.name === remoteName) {
        this.uiStateService.resetSelectedRemote();
      }
    } catch (error) {
      console.error('Delete remote failed:', error);
      this.notificationService.showError(error);
    }
  }
}

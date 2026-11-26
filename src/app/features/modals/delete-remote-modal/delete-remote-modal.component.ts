import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { TitleCasePipe, UpperCasePipe } from '@angular/common';

import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { WorkflowStorageService } from 'src/app/services/flow/workflow-storage.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { OPERATION_REGISTRY, PillTone, RemoteSettings } from '@app/types';
import { WorkflowRef } from 'src/app/flow/workflow/types/workflow.types';

import { PillDirective } from '../../../shared/directives/pill.directive';
import { EscapeCloseDirective } from '../../../shared/directives/escape-close.directive';
export interface DeleteRemoteModalData {
  remoteName: string;
}

export interface ProfileItem {
  type: string;
  name: string;
  icon: string;
  tone: PillTone;
  actionLabel: string;
}

@Component({
  selector: 'app-delete-remote-modal',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    MatButtonModule,
    MatIconModule,
    TranslatePipe,
    TitleCasePipe,
    UpperCasePipe,
    AlertBannerComponent,
    PillDirective,
  ],
  templateUrl: './delete-remote-modal.component.html',
  styleUrls: ['./delete-remote-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeleteRemoteModalComponent {
  private readonly dialogRef = inject(MatDialogRef<DeleteRemoteModalComponent>);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly jobService = inject(JobManagementService);
  private readonly quickRunService = inject(QuickRunService);
  private readonly automationService = inject(AutomationService);
  private readonly workflowStorage = inject(WorkflowStorageService);
  private readonly pathService = inject(PathService);
  readonly iconService = inject(IconService);

  private readonly data: DeleteRemoteModalData = inject(MAT_DIALOG_DATA);
  readonly remoteName = this.data.remoteName;

  constructor() {
    this.workflowStorage
      .listWorkflowsUsingRemote(this.remoteName)
      .then(workflows => this.workflowsList.set(workflows))
      .catch(error => console.error('Could not list the workflows using the remote:', error));
  }

  readonly isDeleting = signal(false);

  readonly remote = computed(() => this.remoteFacade.getRemote(this.remoteName));

  readonly remoteType = computed(() => this.remote()?.type ?? 'generic');

  readonly activeMounts = computed(() =>
    this.remoteFacade
      .mountedRemotes()
      .filter(m => this.pathService.getRemoteNameFromFs(m.fs) === this.remoteName)
  );

  readonly activeServes = computed(() =>
    this.remoteFacade
      .runningServes()
      .filter(s => this.pathService.getRemoteNameFromFs(s.params?.fs) === this.remoteName)
  );

  /** The file browser names the remote as rclone writes it (`drive:`), a profile without the colon. */
  readonly activeJobs = computed(() =>
    this.jobService
      .jobs()
      .filter(j => j.status === 'Running' && j.remote_name.replace(/:$/, '') === this.remoteName)
  );

  readonly hasActiveOperations = computed(
    () =>
      this.activeMounts().length > 0 ||
      this.activeServes().length > 0 ||
      this.activeJobs().length > 0
  );

  readonly profilesList = computed<ProfileItem[]>(() => {
    const settings = this.remoteFacade.getRemoteSettings(this.remoteName);
    if (!settings) return [];

    const items: ProfileItem[] = [];
    for (const opDef of OPERATION_REGISTRY) {
      if (!opDef.configKey) continue;
      const configMap = settings[opDef.configKey as keyof RemoteSettings] as
        Record<string, unknown> | undefined;
      if (configMap && typeof configMap === 'object') {
        for (const profileName of Object.keys(configMap)) {
          items.push({
            type: opDef.key,
            name: profileName,
            icon: opDef.icon,
            tone: opDef.tone,
            actionLabel: opDef.actionLabel,
          });
        }
      }
    }
    return items;
  });

  readonly quickRunsList = computed(() =>
    this.quickRunService.quickRuns().filter(qr => qr.remoteName === this.remoteName)
  );

  readonly automationsList = computed(() =>
    this.automationService.automations().filter(a => a.remoteName === this.remoteName)
  );

  /** The backend knows how the engine reads a node, so it says which workflows use this remote. */
  readonly workflowsList = signal<WorkflowRef[]>([]);

  getOpIcon(op: string): string {
    return OPERATION_REGISTRY.find(d => d.key === op)?.icon ?? 'quick-run';
  }

  getOpTone(op: string): PillTone {
    return OPERATION_REGISTRY.find(d => d.key === op)?.tone ?? 'accent';
  }

  onConfirm(): void {
    this.isDeleting.set(true);
    this.dialogRef.close(true);
  }

  onCancel(): void {
    this.dialogRef.close(false);
  }
}

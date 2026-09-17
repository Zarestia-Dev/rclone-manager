import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
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
import { OPERATION_REGISTRY, QuickRun, RemoteSettings, RCLONE_PATH_KEYS } from '@app/types';
import { WorkflowDefinition, WorkflowNode } from 'src/app/flow/workflow/types/workflow.types';

export interface DeleteRemoteModalData {
  remoteName: string;
}

export interface ProfileItem {
  type: string;
  name: string;
  icon: string;
  cssClass: string;
  actionLabel: string;
}

@Component({
  selector: 'app-delete-remote-modal',
  imports: [
    MatButtonModule,
    MatIconModule,
    TranslatePipe,
    TitleCasePipe,
    UpperCasePipe,
    AlertBannerComponent,
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
    void this.workflowStorage.loadAllWorkflows();
  }

  readonly isDeleting = signal(false);

  readonly remote = computed(() =>
    this.remoteFacade.orderedRemotes().find(r => r.name === this.remoteName)
  );

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

  readonly activeJobs = computed(() =>
    this.jobService.jobs().filter(j => j.remote_name === this.remoteName && j.status === 'Running')
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
            cssClass: opDef.cssClass,
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

  readonly workflowsList = computed(() => {
    const target = this.pathService.normalizeRemoteName(this.remoteName);
    if (!target) return [];

    const allWorkflows = this.workflowStorage.workflows();
    const allQuickRuns = this.quickRunService.quickRuns();

    return allWorkflows.filter(wf => this.isWorkflowUsingRemote(wf, target, allQuickRuns));
  });

  private isWorkflowUsingRemote(
    wf: WorkflowDefinition,
    targetClean: string,
    quickRuns: QuickRun[]
  ): boolean {
    if (!wf.nodes || !Array.isArray(wf.nodes)) return false;
    return wf.nodes.some(node => this.isNodeUsingRemote(node, targetClean, quickRuns));
  }

  private isNodeUsingRemote(
    node: WorkflowNode,
    targetClean: string,
    quickRuns: QuickRun[]
  ): boolean {
    if (!node) return false;

    // Quick run node reference
    if (node.type === 'quick_run') {
      const qrId = node.config?.['quickRunId'];
      if (typeof qrId === 'string' && qrId.trim()) {
        const qr = quickRuns.find(q => q.id === qrId.trim());
        if (qr && this.pathService.normalizeRemoteName(qr.remoteName) === targetClean) {
          return true;
        }
      }
    }

    return this.checkConfigForRemote(node.config, targetClean);
  }

  private checkConfigForRemote(
    cfg: Record<string, unknown> | undefined | null,
    targetClean: string
  ): boolean {
    if (!cfg || typeof cfg !== 'object') return false;

    const directRemoteKeys = ['remoteName', 'remote', 'remote_name', 'targetRemote'];
    for (const key of directRemoteKeys) {
      const val = cfg[key];
      if (typeof val === 'string' && val.trim()) {
        if (this.pathService.normalizeRemoteName(val) === targetClean) {
          return true;
        }
      }
    }

    const pathKeys = [...RCLONE_PATH_KEYS, 'url', 'watchPaths'] as const;
    for (const key of pathKeys) {
      const val = cfg[key];
      if (this.isPathMatchingRemote(val, targetClean)) {
        return true;
      }
    }

    if (cfg['config'] && typeof cfg['config'] === 'object') {
      if (this.checkConfigForRemote(cfg['config'] as Record<string, unknown>, targetClean)) {
        return true;
      }
    }

    if (cfg['rclone'] && typeof cfg['rclone'] === 'object') {
      if (this.checkConfigForRemote(cfg['rclone'] as Record<string, unknown>, targetClean)) {
        return true;
      }
    }

    if (cfg['params'] && typeof cfg['params'] === 'object') {
      if (this.checkConfigForRemote(cfg['params'] as Record<string, unknown>, targetClean)) {
        return true;
      }
    }

    return false;
  }

  private isPathMatchingRemote(val: unknown, targetClean: string): boolean {
    if (!val) return false;

    if (Array.isArray(val)) {
      return val.some(item => this.isPathMatchingRemote(item, targetClean));
    }

    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (!trimmed) return false;

      if (trimmed.startsWith(`${targetClean}:`)) {
        return true;
      }

      const fromFs = this.pathService.getRemoteNameFromFs(trimmed);
      if (fromFs && fromFs !== 'local' && fromFs === targetClean) {
        return true;
      }
    }

    return false;
  }

  getOpIcon(op: string): string {
    return OPERATION_REGISTRY.find(d => d.key === op)?.icon ?? 'quick-run';
  }

  getOpPillClass(op: string): string {
    const css = OPERATION_REGISTRY.find(d => d.key === op)?.cssClass ?? 'accent';
    return `p-${css}`;
  }

  @HostListener('document:keydown.escape', ['$event'])
  onEscapeKey(event: Event): void {
    if (!this.isDeleting()) {
      event.preventDefault();
      this.onCancel();
    }
  }

  onConfirm(): void {
    this.isDeleting.set(true);
    this.dialogRef.close(true);
  }

  onCancel(): void {
    this.dialogRef.close(false);
  }
}

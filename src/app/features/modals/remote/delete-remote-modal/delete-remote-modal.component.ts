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
import { IconService } from 'src/app/services/ui/icon.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { OPERATION_REGISTRY, RemoteSettings } from '@app/types';

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
  styleUrls: ['./delete-remote-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeleteRemoteModalComponent {
  private readonly dialogRef = inject(MatDialogRef<DeleteRemoteModalComponent>);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly jobService = inject(JobManagementService);
  private readonly quickRunService = inject(QuickRunService);
  private readonly automationService = inject(AutomationService);
  private readonly pathService = inject(PathService);
  public readonly iconService = inject(IconService);

  public readonly data: DeleteRemoteModalData = inject(MAT_DIALOG_DATA);
  public readonly remoteName = this.data.remoteName;

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

  readonly activeServes = computed(() => {
    const prefix = `${this.remoteName}:`;
    return this.remoteFacade.runningServes().filter(s => s.params?.fs?.startsWith(prefix));
  });

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
      const keyboardEvent = event as KeyboardEvent;
      keyboardEvent.preventDefault();
      this.onCancel();
    }
  }

  onConfirm(): void {
    this.dialogRef.close(true);
  }

  onCancel(): void {
    this.dialogRef.close(false);
  }
}

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe } from '@ngx-translate/core';

import { OpenInFilesEvent } from '@app/types';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { AppDetailComponent } from 'src/app/features/components/dashboard/app-detail/app-detail.component';
import { QuickRunOverviewComponent } from '../quick-run-overview/quick-run-overview.component';

/**
 * Main detail / editor panel view for the Quick Run feature in Flow.
 */
@Component({
  selector: 'app-quick-run-workspace',
  imports: [
    MatIconModule,
    MatButtonModule,
    CdkMenuModule,
    TranslatePipe,
    AppDetailComponent,
    QuickRunOverviewComponent,
  ],
  templateUrl: './quick-run-workspace.component.html',
  styleUrl: './quick-run-workspace.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuickRunWorkspaceComponent {
  private readonly quickRunService = inject(QuickRunService);
  private readonly remoteFacade = inject(RemoteFacadeService);

  readonly quickRuns = this.quickRunService.quickRuns;
  readonly selected = this.quickRunService.selected;
  readonly runningIds = this.quickRunService.runningIds;

  editQuickRun(id: string): void {
    const qr = this.quickRuns().find(q => q.id === id);
    if (qr) this.quickRunService.openEditor(qr);
  }

  closeDetail(): void {
    this.quickRunService.select(null);
  }

  async startQuickRun(id: string): Promise<void> {
    await this.quickRunService.start(id);
  }

  async stopQuickRun(id: string): Promise<void> {
    await this.quickRunService.stop(id);
  }

  async duplicateQuickRun(id: string): Promise<void> {
    await this.quickRunService.duplicate(id);
  }

  async removeQuickRun(id: string): Promise<void> {
    await this.quickRunService.remove(id);
  }

  isRunning(id: string): boolean {
    return this.runningIds().has(id);
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
}

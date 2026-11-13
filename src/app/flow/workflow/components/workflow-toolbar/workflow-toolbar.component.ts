import { Component, ChangeDetectionStrategy, computed, inject, output, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { WorkflowStorageService } from '../../../../services/flow/workflow-storage.service';
import { BackendTranslationService } from '../../../../services/i18n/backend-translation.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { WorkflowTemplate } from '../../types/workflow.types';

@Component({
  selector: 'app-workflow-toolbar',
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatDividerModule,
    CdkMenuModule,
    TranslatePipe,
  ],
  templateUrl: './workflow-toolbar.component.html',
  styleUrl: './workflow-toolbar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowToolbarComponent {
  readonly stateService = inject(WorkflowStateService);
  readonly engineService = inject(WorkflowEngineService);
  readonly storageService = inject(WorkflowStorageService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly backendTranslation = inject(BackendTranslationService);

  /** The step that is running, translated when it is shown: the run keeps what the backend sent. */
  readonly stepTitle = computed(() => {
    const title = this.engineService.executionProgress()?.currentStepTitle;
    return title ? this.backendTranslation.translateBackendMessage(title) : '';
  });

  readonly isPaletteOpen = input<boolean>(true);
  readonly isRunOpen = input<boolean>(false);

  readonly togglePalette = output<void>();
  readonly toggleRun = output<void>();

  readonly activeWorkflow = this.stateService.currentWorkflow;

  readonly allWorkflows = this.storageService.workflows;

  onNameInput(newName: string): void {
    this.stateService.setWorkflowName(newName);
  }

  onNameBlur(): void {
    if (this.stateService.hasUnsavedChanges()) {
      void this.storageService.saveCurrentWorkflow();
    }
  }

  runWorkflow(): void {
    const current = this.stateService.currentWorkflow();
    if (current) {
      void this.engineService.executeWorkflow(current, false);
    }
  }

  runWorkflowDryRun(): void {
    const current = this.stateService.currentWorkflow();
    if (current) {
      void this.engineService.executeWorkflow(current, true);
    }
  }

  stopWorkflow(): void {
    this.engineService.stopWorkflow();
  }

  async saveWorkflow(): Promise<void> {
    if (await this.storageService.saveCurrentWorkflow()) {
      this.notificationService.showSuccess(this.translate.instant('common.savedSuccessfully'));
    }
  }

  createNew(): void {
    void this.storageService.createAndOpenWorkflow();
  }

  loadWorkflowById(id: string): void {
    const wf = this.storageService.workflows().find(w => w.id === id);
    if (wf) void this.storageService.openWorkflow(wf);
  }

  async duplicateWorkflow(event: Event, id: string): Promise<void> {
    event.stopPropagation();
    await this.storageService.duplicateWorkflowWithFeedback(id);
  }

  async deleteWorkflow(event: Event, id: string): Promise<void> {
    event.stopPropagation();
    await this.storageService.promptAndDeleteWorkflow(id);
  }

  loadTemplate(tpl: WorkflowTemplate): void {
    void this.storageService.openTemplate(tpl);
  }

  undo(): void {
    this.stateService.undo();
  }

  redo(): void {
    this.stateService.redo();
  }

  toggleSnapToGrid(): void {
    this.stateService.snapToGrid.set(!this.stateService.snapToGrid());
  }
}

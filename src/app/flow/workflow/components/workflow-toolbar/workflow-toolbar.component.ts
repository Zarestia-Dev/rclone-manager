import { Component, ChangeDetectionStrategy, inject, output, input, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { WorkflowStorageService } from '../../../../services/flow/workflow-storage.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { WorkflowTemplate } from '../../types/workflow.types';

@Component({
  selector: 'app-workflow-toolbar',
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
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

  readonly isPaletteOpen = input<boolean>(true);
  readonly isLogOpen = input<boolean>(false);

  readonly togglePalette = output<void>();
  readonly toggleLog = output<void>();

  readonly activeWorkflow = this.stateService.currentWorkflow;
  readonly zoomPercentage = computed(() => Math.round(this.stateService.viewport().zoom * 100));

  readonly presetTemplates = computed(() => this.storageService.getPresetTemplates());
  readonly allWorkflows = this.storageService.workflows;

  readonly hasDuplicateWorkflows = computed(() => {
    const list = this.allWorkflows();
    const names = new Set<string>();
    for (const w of list) {
      if (names.has(w.name)) return true;
      names.add(w.name);
    }
    return false;
  });

  onNameInput(newName: string): void {
    this.stateService.setWorkflowName(newName);
  }

  onNameBlur(): void {
    const current = this.stateService.currentWorkflow();
    if (current) {
      void this.storageService.saveWorkflow(current);
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

  saveWorkflow(): void {
    const current = this.stateService.currentWorkflow();
    if (current) {
      void this.storageService.saveWorkflow(current);
      this.notificationService.showSuccess(this.translate.instant('common.savedSuccessfully'));
    }
  }

  createNew(): void {
    const newWf = this.stateService.createNewWorkflow();
    void this.storageService.saveWorkflow(newWf);
  }

  loadWorkflowById(id: string): void {
    const wf = this.storageService.workflows().find(w => w.id === id);
    if (wf) {
      this.stateService.loadWorkflow(wf);
    }
  }

  async duplicateWorkflow(event: Event, id: string): Promise<void> {
    event.stopPropagation();
    await this.storageService.duplicateWorkflowWithFeedback(id);
  }

  async deleteWorkflow(event: Event, id: string): Promise<void> {
    event.stopPropagation();
    await this.storageService.promptAndDeleteWorkflow(id);
  }

  async cleanDuplicates(): Promise<void> {
    const confirmed = await this.notificationService.confirmModal(
      'flow.workflow.cleanDuplicates',
      this.translate.instant('flow.workflow.cleanDuplicatesConfirm'),
      'flow.workflow.cleanDuplicates',
      'common.cancel',
      { color: 'warn', icon: 'broom' }
    );
    if (!confirmed) return;

    await this.storageService.cleanDuplicates();
    this.notificationService.showSuccess(this.translate.instant('common.savedSuccessfully'));
  }

  loadTemplate(tpl: WorkflowTemplate): void {
    const instantiated = this.storageService.instantiateTemplate(tpl.id);
    this.stateService.loadWorkflow(instantiated);
    void this.storageService.saveWorkflow(instantiated);
  }
}

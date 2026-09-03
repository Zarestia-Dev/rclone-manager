import { Injectable, inject, signal } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { WorkflowDefinition, WorkflowTemplate } from '../../flow/workflow/types/workflow.types';
import { BUILTIN_WORKFLOW_TEMPLATES } from './recipes/workflow-recipes';
import { findUniqueName } from '../remote/utils/unique-name.util';
import { WorkflowStateService } from './workflow-state.service';

@Injectable({ providedIn: 'root' })
export class WorkflowStorageService extends TauriBaseService {
  private readonly stateService = inject(WorkflowStateService);

  readonly workflows = signal<WorkflowDefinition[]>([]);
  readonly isLoading = signal<boolean>(false);

  constructor() {
    super();
    void this.loadAllWorkflows();
  }

  /**
   * Loads all saved workflows from the Rust backend store.
   */
  async loadAllWorkflows(): Promise<WorkflowDefinition[]> {
    this.isLoading.set(true);
    try {
      let list = await this.invokeCommand<WorkflowDefinition[]>('list_workflows');
      if (!list || list.length === 0) {
        const initial = this.instantiateTemplate('tpl-daily-backup-notify');
        const created = await this.invokeCommand<WorkflowDefinition>('create_workflow', {
          workflow: initial,
        });
        list = [created ?? initial];
      }
      this.workflows.set(list || []);
      return list || [];
    } catch (err) {
      console.error('[WorkflowStorageService] Failed to load workflows:', err);
      return [];
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Cleans duplicate workflows with identical names, keeping only the first one.
   */
  async cleanDuplicates(): Promise<number> {
    const list = this.workflows();
    const seenNames = new Set<string>();
    const toDelete: string[] = [];

    for (const wf of list) {
      if (seenNames.has(wf.name)) {
        toDelete.push(wf.id);
      } else {
        seenNames.add(wf.name);
      }
    }

    for (const id of toDelete) {
      try {
        await this.invokeCommand('delete_workflow', { workflowId: id });
      } catch (err) {
        console.error(`Failed to delete duplicate workflow ${id}:`, err);
      }
    }

    await this.loadAllWorkflows();
    return toDelete.length;
  }

  /**
   * Persists a new or updated workflow to the Rust backend.
   */
  async saveWorkflow(workflow: WorkflowDefinition): Promise<WorkflowDefinition> {
    const exists = this.workflows().some(w => w.id === workflow.id);
    const saved = exists
      ? await this.invokeCommand<WorkflowDefinition>('update_workflow', { workflow })
      : await this.invokeCommand<WorkflowDefinition>('create_workflow', { workflow });

    await this.loadAllWorkflows();
    if (this.stateService.currentWorkflow()?.id === workflow.id) {
      this.stateService.markSaved(saved ?? workflow);
    }
    return saved;
  }

  /**
   * Deletes a workflow by ID from the Rust backend.
   */
  async deleteWorkflow(id: string): Promise<void> {
    await this.invokeCommand('delete_workflow', { workflowId: id });
    await this.loadAllWorkflows();
  }

  /**
   * Duplicates an existing workflow via the Rust backend.
   */
  async duplicateWorkflow(id: string): Promise<WorkflowDefinition | null> {
    const duplicated = await this.invokeCommand<WorkflowDefinition>('duplicate_workflow', {
      workflowId: id,
    });
    await this.loadAllWorkflows();
    return duplicated;
  }

  /**
   * Duplicates a workflow, loads it into active canvas, and shows a success notification.
   */
  async duplicateWorkflowWithFeedback(id: string): Promise<WorkflowDefinition | null> {
    const duplicated = await this.duplicateWorkflow(id);
    if (duplicated) {
      this.stateService.loadWorkflow(duplicated);
      this.notificationService.showSuccess(this.translate.instant('common.savedSuccessfully'));
    }
    return duplicated;
  }

  /**
   * Shows a confirmation modal, deletes the workflow, and updates canvas state if active.
   */
  async promptAndDeleteWorkflow(id: string): Promise<boolean> {
    const confirmed = await this.notificationService.confirmModal(
      'flow.workflow.actions.deleteWorkflow',
      this.translate.instant('flow.workflow.deleteConfirm'),
      'common.delete',
      'common.cancel',
      { color: 'warn', icon: 'trash' }
    );
    if (!confirmed) return false;

    await this.deleteWorkflow(id);
    if (this.stateService.currentWorkflow()?.id === id) {
      const remaining = this.workflows();
      if (remaining.length > 0) {
        this.stateService.loadWorkflow(remaining[0]);
      } else {
        const newWf = this.stateService.createNewWorkflow();
        await this.saveWorkflow(newWf);
      }
    }
    this.notificationService.showSuccess(this.translate.instant('common.deletedSuccessfully'));
    return true;
  }

  /**
   * Serializes a workflow definition to formatted JSON via backend.
   */
  async exportWorkflowJson(workflow: WorkflowDefinition): Promise<string> {
    if (workflow.id) {
      return await this.invokeCommand<string>('export_workflow', {
        workflowId: workflow.id,
      });
    }
    return JSON.stringify(workflow, null, 2);
  }

  /**
   * Parses, validates, and persists a JSON string into a WorkflowDefinition.
   */
  async importWorkflowJson(jsonStr: string): Promise<WorkflowDefinition> {
    const imported = await this.invokeCommand<WorkflowDefinition>('import_workflow', { jsonStr });
    await this.loadAllWorkflows();
    return imported;
  }

  /**
   * Returns the list of pre-configured workflow templates.
   */
  getPresetTemplates(): WorkflowTemplate[] {
    return BUILTIN_WORKFLOW_TEMPLATES;
  }

  /**
   * Creates a new WorkflowDefinition instance from a template.
   */
  instantiateTemplate(templateId: string): WorkflowDefinition {
    const tpl =
      BUILTIN_WORKFLOW_TEMPLATES.find(t => t.id === templateId) ?? BUILTIN_WORKFLOW_TEMPLATES[0];

    const existingNames = this.workflows().map(w => w.name);
    const uniqueName = findUniqueName(tpl.definition.name, existingNames);

    const instantiated: WorkflowDefinition = {
      id: `wf-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      ...structuredClone(tpl.definition),
      name: uniqueName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return instantiated;
  }
}

import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { merge } from 'rxjs';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { WorkflowDefinition, WorkflowTemplate } from '../../flow/workflow/types/workflow.types';
import { toPersistableWorkflow } from '../../flow/workflow/utils/workflow-persist.util';
import { findUniqueName } from '../remote/utils/unique-name.util';
import { generatePrefixedId } from '../../shared/utils';
import { WorkflowStateService } from './workflow-state.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';

@Injectable({ providedIn: 'root' })
export class WorkflowStorageService extends TauriBaseService {
  private readonly stateService = inject(WorkflowStateService);
  private readonly eventListeners = inject(EventListenersService);
  private readonly destroyRef = inject(DestroyRef);

  readonly workflows = signal<WorkflowDefinition[]>([]);
  readonly isLoading = signal<boolean>(false);
  readonly isSaving = signal<boolean>(false);
  private readonly _presetTemplates = signal<WorkflowTemplate[]>([]);
  readonly presetTemplates = this._presetTemplates.asReadonly();

  private loadInFlight: Promise<WorkflowDefinition[]> | null = null;
  private nextLoadPromise: Promise<WorkflowDefinition[]> | null = null;

  constructor() {
    super();
    void this.loadAllWorkflows();

    // Workflows belong to the selected backend.
    merge(
      this.eventListeners.listenToSettingsCategory('workflows'),
      this.eventListeners.listenToBackendSwitched()
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        void this.loadAllWorkflows();
      });
  }

  /**
   * Loads all saved workflows from the Rust backend store.
   */
  async loadAllWorkflows(): Promise<WorkflowDefinition[]> {
    if (this.loadInFlight) {
      if (!this.nextLoadPromise) {
        this.nextLoadPromise = this.loadInFlight
          .catch(() => [])
          .then(() => {
            this.nextLoadPromise = null;
            return this.loadAllWorkflows();
          });
      }
      return this.nextLoadPromise;
    }

    const promise = (async (): Promise<WorkflowDefinition[]> => {
      this.isLoading.set(true);
      try {
        const list = await this.invokeCommand<WorkflowDefinition[]>('list_workflows');
        const workflows = list || [];
        this.workflows.set(workflows);

        if (workflows.length > 0) {
          const current = this.stateService.currentWorkflow();
          const currentStillExists = current && workflows.some(w => w.id === current.id);
          if (!currentStillExists) {
            this.stateService.loadWorkflow(workflows[0]);
          }
        } else {
          this.stateService.currentWorkflow.set(null);
        }

        return workflows;
      } catch (err) {
        console.error('[WorkflowStorageService] Failed to load workflows:', err);
        return [];
      } finally {
        if (!this.nextLoadPromise) {
          this.isLoading.set(false);
        }
        this.loadInFlight = null;
      }
    })();

    this.loadInFlight = promise;
    return promise;
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
  async saveWorkflow(
    workflow: WorkflowDefinition,
    markCanvasSaved = true
  ): Promise<WorkflowDefinition> {
    const exists = this.workflows().some(w => w.id === workflow.id);
    const persistable = toPersistableWorkflow(workflow);
    const saved = exists
      ? await this.invokeCommand<WorkflowDefinition>('update_workflow', { workflow: persistable })
      : await this.invokeCommand<WorkflowDefinition>('create_workflow', { workflow: persistable });

    await this.loadAllWorkflows();
    if (markCanvasSaved && this.stateService.currentWorkflow()?.id === workflow.id) {
      this.stateService.markSaved(saved ?? workflow);
    }
    return saved;
  }

  /**
   * Saves the workflow on the canvas and tells the user if that fails.
   */
  async saveCurrentWorkflow(): Promise<boolean> {
    const current = this.stateService.currentWorkflow();
    if (!current || this.isSaving()) return false;
    this.isSaving.set(true);
    try {
      return await this.saveWithFeedback(current);
    } finally {
      this.isSaving.set(false);
    }
  }

  /**
   * Starts a blank workflow on the canvas and stores it.
   */
  async createAndOpenWorkflow(): Promise<void> {
    await this.saveWithFeedback(this.stateService.createNewWorkflow());
  }

  /**
   * Puts a copy of a template on the canvas and stores it.
   */
  async openTemplate(templateOrId: WorkflowTemplate | string): Promise<void> {
    const instantiated = this.instantiateTemplate(templateOrId);
    this.stateService.loadWorkflow(instantiated);
    await this.saveWithFeedback(instantiated);
  }

  /**
   * Stores the tray setting, which only lives in the stored workflow. If the workflow
   * is already stored, nothing else changes: edits on the canvas stay unsaved.
   */
  async saveShowOnTray(workflowId: string, showOnTray: boolean): Promise<boolean> {
    const stored = this.workflows().find(w => w.id === workflowId);
    if (!stored) return this.saveCurrentWorkflow();
    return this.saveWithFeedback({ ...stored, showOnTray }, false);
  }

  private async saveWithFeedback(
    workflow: WorkflowDefinition,
    markCanvasSaved = true
  ): Promise<boolean> {
    try {
      await this.saveWorkflow(workflow, markCanvasSaved);
      return true;
    } catch (error) {
      console.error('[WorkflowStorage] Failed to save workflow:', error);
      this.notificationService.showError(
        this.backendTranslation.translateBackendMessage(error) ||
          this.translate.instant('common.error')
      );
      return false;
    }
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
        this.stateService.currentWorkflow.set(null);
      }
    }
    this.notificationService.showSuccess(this.translate.instant('common.deletedSuccessfully'));
    return true;
  }

  /**
   * Lazily loads and returns the list of pre-configured workflow templates.
   */
  async loadPresetTemplates(): Promise<WorkflowTemplate[]> {
    if (this.presetTemplates().length === 0) {
      const { BUILTIN_WORKFLOW_TEMPLATES } = await import('./recipes/workflow-recipes');
      this._presetTemplates.set(BUILTIN_WORKFLOW_TEMPLATES);
    }
    return this.presetTemplates();
  }

  /**
   * Creates a new WorkflowDefinition instance from a template.
   */
  instantiateTemplate(templateOrId: WorkflowTemplate | string): WorkflowDefinition {
    const tpl =
      typeof templateOrId === 'string'
        ? this.presetTemplates().find(t => t.id === templateOrId)
        : templateOrId;

    if (!tpl) {
      throw new Error(
        `Template not loaded: ${typeof templateOrId === 'string' ? templateOrId : ''}`
      );
    }

    const existingNames = this.workflows().map(w => w.name);
    const uniqueName = findUniqueName(tpl.definition.name, existingNames);

    const instantiated: WorkflowDefinition = {
      ...structuredClone(tpl.definition),
      id: generatePrefixedId('wf'),
      name: uniqueName,
      showOnTray: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return instantiated;
  }
}

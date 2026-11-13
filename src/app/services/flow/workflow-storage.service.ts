import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { merge } from 'rxjs';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import {
  WorkflowChecks,
  WorkflowDefinition,
  WorkflowTemplate,
} from '../../flow/workflow/types/workflow.types';
import { toPersistableWorkflow } from '../../flow/workflow/utils/workflow-persist.util';
import { findUniqueName } from '../remote/utils/unique-name.util';
import { generatePrefixedId } from '../../shared/utils';
import { WorkflowStateService } from './workflow-state.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';

/** Keys under this prefix in a template's node settings stand for text to translate when the template is copied. */
const TEMPLATE_TEXT_PREFIX = 'flow.workflow.recipes.';

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
   * Puts a workflow the backend just stored into the list, where the backend keeps it: sorted
   * by name. The list is not fetched again; the settings event that follows every change
   * does that, and brings anything another window changed.
   */
  private putInList(workflow: WorkflowDefinition): void {
    this.workflows.update(list =>
      [...list.filter(w => w.id !== workflow.id), workflow].sort((a, b) => {
        const [left, right] = [a.name.toLowerCase(), b.name.toLowerCase()];
        return left < right ? -1 : left > right ? 1 : 0;
      })
    );
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

    this.putInList(saved ?? persistable);
    if (markCanvasSaved && this.stateService.currentWorkflow()?.id === workflow.id) {
      this.stateService.markSaved(saved ?? workflow);
    }
    return saved;
  }

  /**
   * Saves the workflow on the canvas and tells the user if that fails.
   */
  async saveCurrentWorkflow(): Promise<boolean> {
    const current = this.stateService.workflowToStore();
    if (!current || this.isSaving()) return false;
    this.isSaving.set(true);
    try {
      return await this.saveWithFeedback(current);
    } finally {
      this.isSaving.set(false);
    }
  }

  /**
   * Asks before the workflow on the canvas is replaced, if it has changes that are not saved.
   */
  async confirmDiscardUnsaved(): Promise<boolean> {
    if (!this.stateService.hasUnsavedChanges()) return true;
    return this.notificationService.confirmModal(
      'flow.workflow.unsavedChanges',
      this.translate.instant('flow.workflow.discardConfirm'),
      'flow.workflow.discard',
      'common.cancel',
      { color: 'warn', icon: 'warning' }
    );
  }

  /**
   * Puts a stored workflow on the canvas, unless the user keeps the unsaved changes of the
   * one that is there. Opening the workflow that is already open changes nothing.
   */
  async openWorkflow(workflow: WorkflowDefinition): Promise<boolean> {
    if (this.stateService.currentWorkflowId() === workflow.id) return true;
    if (!(await this.confirmDiscardUnsaved())) return false;
    this.stateService.loadWorkflow(workflow);
    return true;
  }

  /**
   * Starts a blank workflow on the canvas and stores it.
   */
  async createAndOpenWorkflow(): Promise<void> {
    if (!(await this.confirmDiscardUnsaved())) return;
    await this.saveWithFeedback(this.stateService.createNewWorkflow());
  }

  /**
   * Puts a copy of a template on the canvas and stores it.
   */
  async openTemplate(templateOrId: WorkflowTemplate | string): Promise<void> {
    if (!(await this.confirmDiscardUnsaved())) return;
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
    this.workflows.update(list => list.filter(w => w.id !== id));
    this.stateService.forgetRunResults(id);
  }

  /**
   * Duplicates an existing workflow via the Rust backend.
   */
  async duplicateWorkflow(id: string): Promise<WorkflowDefinition | null> {
    const duplicated = await this.invokeCommand<WorkflowDefinition>('duplicate_workflow', {
      workflowId: id,
    });
    if (duplicated) this.putInList(duplicated);
    return duplicated;
  }

  /**
   * Duplicates a workflow, loads it into active canvas, and shows a success notification.
   */
  async duplicateWorkflowWithFeedback(id: string): Promise<WorkflowDefinition | null> {
    if (!(await this.confirmDiscardUnsaved())) return null;
    const duplicated = await this.duplicateWorkflow(id);
    if (duplicated) {
      this.stateService.loadWorkflow(duplicated);
      this.notificationService.showSuccess(this.translate.instant('common.savedSuccessfully'));
    }
    return duplicated;
  }

  /**
   * Asks the backend to check a workflow the way a run would, without storing it. The
   * messages come back translated.
   */
  async validateWorkflow(workflow: WorkflowDefinition): Promise<WorkflowChecks> {
    const result = await this.invokeCommand<WorkflowChecks>('validate_workflow', {
      workflow: toPersistableWorkflow(workflow),
    });
    const show = (message: string): string =>
      this.backendTranslation.translateBackendMessage(message);
    return { errors: result.errors.map(show), warnings: result.warnings.map(show) };
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
    const uniqueName = findUniqueName(this.translate.instant(tpl.nameKey), existingNames);

    // The template holds keys for what a user reads (the text of a notification); the copy
    // holds that text in the language of the interface, as the user can then edit it.
    const text = (value: unknown): unknown =>
      typeof value === 'string' && value.startsWith(TEMPLATE_TEXT_PREFIX)
        ? this.translate.instant(value)
        : value;
    const definition = structuredClone(tpl.definition);

    const instantiated: WorkflowDefinition = {
      ...definition,
      description: this.translate.instant(tpl.descriptionKey),
      nodes: definition.nodes.map(node => ({
        ...node,
        title: this.translate.instant(node.titleKey),
        config: Object.fromEntries(Object.entries(node.config).map(([k, v]) => [k, text(v)])),
      })),
      id: generatePrefixedId('wf'),
      name: uniqueName,
      showOnTray: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return instantiated;
  }
}

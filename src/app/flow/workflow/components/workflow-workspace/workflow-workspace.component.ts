import {
  Component,
  ChangeDetectionStrategy,
  HostListener,
  inject,
  signal,
  computed,
  effect,
  DestroyRef,
  afterNextRender,
} from '@angular/core';
import { MatSidenavModule, MatDrawerMode } from '@angular/material/sidenav';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { WorkflowToolbarComponent } from '../workflow-toolbar/workflow-toolbar.component';
import { WorkflowPaletteComponent } from '../workflow-palette/workflow-palette.component';
import { WorkflowCanvasComponent } from '../workflow-canvas/workflow-canvas.component';
import { WorkflowInspectorComponent } from '../workflow-inspector/workflow-inspector.component';
import { WorkflowExecutionLogComponent } from '../workflow-execution-log/workflow-execution-log.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { WorkflowStorageService } from '../../../../services/flow/workflow-storage.service';
import { WorkflowEventService } from '../../../../services/flow/workflow-event.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { WorkflowTemplate } from '../../types/workflow.types';
import { isInputFocused, matchesShortcut } from '../../../../shared/utils/keyboard-utils';
import { syncResponsiveSidebar } from '../../../../shared/utils';

@Component({
  selector: 'app-workflow-workspace',
  imports: [
    MatSidenavModule,
    MatIconModule,
    MatButtonModule,
    TranslatePipe,
    WorkflowToolbarComponent,
    WorkflowPaletteComponent,
    WorkflowCanvasComponent,
    WorkflowInspectorComponent,
    WorkflowExecutionLogComponent,
  ],
  templateUrl: './workflow-workspace.component.html',
  styleUrl: './workflow-workspace.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowWorkspaceComponent {
  readonly stateService = inject(WorkflowStateService);
  readonly engineService = inject(WorkflowEngineService);
  readonly storageService = inject(WorkflowStorageService);
  readonly eventService = inject(WorkflowEventService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly sidebarMode = signal<MatDrawerMode>('side');
  readonly isSidebarOver = computed(() => this.sidebarMode() === 'over');

  readonly isPaletteOpen = signal<boolean>(true);
  readonly isLogOpen = signal<boolean>(false);
  readonly isInspectorOpen = signal<boolean>(true);
  readonly isSaving = signal<boolean>(false);

  readonly hasWorkflow = computed(() => !!this.stateService.currentWorkflow());
  readonly hasSelectedNode = computed(() => !!this.stateService.selectedNode());
  readonly presetTemplates = computed(() => this.storageService.getPresetTemplates());

  constructor() {
    afterNextRender(() => {
      syncResponsiveSidebar(960, this.sidebarMode, undefined, this.destroyRef);
      if (typeof window !== 'undefined' && window.innerWidth < 960) {
        this.isPaletteOpen.set(false);
        this.isInspectorOpen.set(false);
      }
    });

    // Auto-open execution console when workflow run starts
    effect(() => {
      if (this.engineService.isExecuting()) {
        this.isLogOpen.set(true);
      }
    });

    // In mobile ('over') mode, auto-open inspector when a node is selected
    effect(() => {
      const node = this.stateService.selectedNode();
      if (node && this.isSidebarOver()) {
        this.isInspectorOpen.set(true);
        this.isPaletteOpen.set(false);
      }
    });
  }

  togglePalette(): void {
    const next = !this.isPaletteOpen();
    this.isPaletteOpen.set(next);
    if (next && this.isSidebarOver()) {
      this.isInspectorOpen.set(false);
    }
  }

  openPalette(): void {
    this.isPaletteOpen.set(true);
    if (this.isSidebarOver()) {
      this.isInspectorOpen.set(false);
    }
  }

  toggleInspector(): void {
    const next = !this.isInspectorOpen();
    this.isInspectorOpen.set(next);
    if (next && this.isSidebarOver()) {
      this.isPaletteOpen.set(false);
    }
  }

  openInspector(): void {
    this.isInspectorOpen.set(true);
    if (this.isSidebarOver()) {
      this.isPaletteOpen.set(false);
    }
  }

  toggleLog(): void {
    this.isLogOpen.update(v => !v);
  }

  onNodeAdded(): void {
    if (this.isSidebarOver()) {
      this.isPaletteOpen.set(false);
    }
  }

  async saveWorkflow(): Promise<void> {
    const current = this.stateService.currentWorkflow();
    if (!current || this.isSaving()) return;
    this.isSaving.set(true);
    try {
      await this.storageService.saveWorkflow(current);
      this.stateService.markSaved(current);
    } catch {
      this.notificationService.showError(this.translate.instant('common.error'));
    } finally {
      this.isSaving.set(false);
    }
  }

  createNewWorkflow(): void {
    const newWf = this.stateService.createNewWorkflow();
    void this.storageService.saveWorkflow(newWf);
  }

  loadTemplate(tpl: WorkflowTemplate): void {
    const instantiated = this.storageService.instantiateTemplate(tpl.id);
    this.stateService.loadWorkflow(instantiated);
    void this.storageService.saveWorkflow(instantiated);
  }

  loadWorkflowById(id: string): void {
    const wf = this.storageService.workflows().find(w => w.id === id);
    if (wf) {
      this.stateService.loadWorkflow(wf);
    }
  }

  getTemplatePillClass(category: string): string {
    switch (category) {
      case 'backup':
        return 'p-primary';
      case 'automation':
        return 'p-orange';
      case 'sync':
        return 'p-accent';
      case 'utility':
        return 'p-purple';
      default:
        return 'p-accent';
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (isInputFocused(event)) return;
    if (matchesShortcut('Ctrl + S', event)) {
      event.preventDefault();
      if (this.stateService.hasUnsavedChanges()) {
        void this.saveWorkflow();
      }
    }
  }
}

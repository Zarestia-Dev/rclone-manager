import {
  Component,
  ChangeDetectionStrategy,
  HostListener,
  inject,
  signal,
  computed,
  effect,
} from '@angular/core';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';
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

@Component({
  selector: 'app-workflow-workspace',
  imports: [
    CommonModule,
    MatSidenavModule,
    MatIconModule,
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

  readonly isPaletteOpen = signal<boolean>(true);
  readonly isLogOpen = signal<boolean>(false);
  readonly isInspectorOpen = signal<boolean>(true);
  readonly isSaving = signal<boolean>(false);

  readonly hasSelectedNode = computed(() => !!this.stateService.selectedNode());

  constructor() {
    // Automatically load the first available workflow when storage populates
    effect(() => {
      const all = this.storageService.workflows();
      if (all.length > 0 && !this.stateService.currentWorkflow()) {
        this.stateService.loadWorkflow(all[0]);
      }
    });

    // Auto-open execution console when workflow run starts
    effect(() => {
      if (this.engineService.isExecuting()) {
        this.isLogOpen.set(true);
      }
    });
  }

  togglePalette(): void {
    this.isPaletteOpen.update(v => !v);
  }

  toggleInspector(): void {
    this.isInspectorOpen.update(v => !v);
  }

  toggleLog(): void {
    this.isLogOpen.update(v => !v);
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

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (this.stateService.hasUnsavedChanges()) {
        void this.saveWorkflow();
      }
    }
  }
}

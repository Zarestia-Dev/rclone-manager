import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { PillTone, WorkflowExecutionState } from '@app/types';
import { BackendTranslationService } from '../../../../services/i18n/backend-translation.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { AlertBannerComponent } from '../../../../shared/components/alert-banner/alert-banner.component';
import { CopyToClipboardDirective } from '../../../../shared/directives/copy-to-clipboard.directive';
import { PillDirective } from '../../../../shared/directives/pill.directive';
import { WorkflowNodeExecutionState } from '../../types/workflow.types';

interface StateLook {
  icon: string;
  tone: PillTone;
}

const RUN_LOOK: Record<WorkflowExecutionState, StateLook> = {
  started: { icon: 'spinner', tone: 'accent' },
  running: { icon: 'spinner', tone: 'accent' },
  completed: { icon: 'check-circle', tone: 'primary' },
  failed: { icon: 'circle-xmark', tone: 'warn' },
  cancelled: { icon: 'pause', tone: 'yellow' },
};

const STEP_LOOK: Record<WorkflowNodeExecutionState, StateLook> = {
  idle: { icon: 'clock', tone: 'dim' },
  queued: { icon: 'clock', tone: 'dim' },
  running: { icon: 'spinner', tone: 'accent' },
  success: { icon: 'check-circle', tone: 'primary' },
  failed: { icon: 'circle-xmark', tone: 'warn' },
  skipped: { icon: 'pause', tone: 'dim' },
};

interface RunStep {
  id: string;
  title: string;
  titleKey?: string;
  state: WorkflowNodeExecutionState;
  durationMs?: number;
  error?: string;
}

/** The states the header counts, in the order it lists them. */
const COUNTED: readonly WorkflowNodeExecutionState[] = ['failed', 'running', 'success', 'skipped'];

/**
 * A card over the canvas with the latest run of the workflow on it: how it stands, how many
 * steps are in which state, then one row per step. The rows scroll, so a workflow of any size
 * fits; failed steps come first, the others keep the order in which they reported. A row opens
 * the step in the inspector, where its output is.
 */
@Component({
  selector: 'app-workflow-run-summary',
  imports: [
    DatePipe,
    MatIconModule,
    TranslatePipe,
    AlertBannerComponent,
    CopyToClipboardDirective,
    PillDirective,
  ],
  templateUrl: './workflow-run-summary.component.html',
  styleUrl: './workflow-run-summary.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowRunSummaryComponent {
  private readonly engineService = inject(WorkflowEngineService);
  private readonly stateService = inject(WorkflowStateService);
  private readonly translate = inject(TranslateService);
  private readonly backendTranslation = inject(BackendTranslationService);

  readonly closePanel = output<void>();

  readonly runLook = RUN_LOOK;
  readonly stepLook = STEP_LOOK;

  /** The workflow's latest run; nothing until it has run. */
  readonly run = computed(() => {
    const id = this.stateService.currentWorkflow()?.id;
    return id === undefined ? undefined : this.engineService.runView(id);
  });

  /** What the backend said about the run's end, in the language of the interface. */
  readonly message = computed(() => {
    const raw = this.run()?.message;
    return raw ? this.backendTranslation.translateBackendMessage(raw) : '';
  });

  readonly steps = computed<RunStep[]>(() => {
    const run = this.run();
    const nodes = this.stateService.currentWorkflow()?.nodes ?? [];
    if (!run) return [];
    const reported = run.steps.flatMap(id => {
      const node = nodes.find(n => n.id === id);
      if (!node) return [];
      return [
        {
          id,
          title: node.title,
          titleKey: node.titleKey,
          state: node.state ?? 'idle',
          durationMs: node.lastDurationMs,
          error: node.errorMessage
            ? this.backendTranslation.translateBackendMessage(node.errorMessage)
            : undefined,
        },
      ];
    });
    // Array.prototype.sort is stable, so only the failed steps move.
    return reported.sort((a, b) => Number(b.state === 'failed') - Number(a.state === 'failed'));
  });

  /** How many steps are in each state worth counting; states nobody is in are left out. */
  readonly counts = computed(() => {
    const steps = this.steps();
    return COUNTED.map(state => ({
      state,
      count: steps.filter(s => s.state === state).length,
    })).filter(c => c.count > 0);
  });

  /** The run as plain text, for the copy button. */
  readonly summaryText = computed(() => {
    const run = this.run();
    if (!run) return '';
    const head = [
      this.translate.instant(`flow.workflow.run.state.${run.state}`),
      run.dryRun ? this.translate.instant('flow.workflow.toolbar.dryRun') : '',
      run.startedAt,
    ].filter(Boolean);
    const lines = this.steps().map(step => {
      const title = step.titleKey ? this.translate.instant(step.titleKey) : step.title;
      const status = this.translate.instant(`flow.workflow.status.${step.state}`);
      const took = step.durationMs !== undefined ? ` (${step.durationMs}ms)` : '';
      return `${title}: ${status}${took}${step.error ? ` - ${step.error}` : ''}`;
    });
    return [head.join(' | '), this.message(), ...lines].filter(Boolean).join('\n');
  });

  openStep(id: string): void {
    this.stateService.selectNode(id, false);
  }
}

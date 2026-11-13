import { Component, ChangeDetectionStrategy, computed, inject, input, output } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatOptionModule } from '@angular/material/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { describeCron } from '../../../../../services/i18n/cron-locale.mapper';
import { WorkflowNode } from '../../../types/workflow.types';
import {
  getAvailableUpstreamNodes,
  getNodeFields,
  getPreviousNodeFields,
  NodeVariableField,
} from '../../../utils/node-fields.util';
import { AlertBannerComponent } from '../../../../../shared/components/alert-banner/alert-banner.component';
import { WorkflowStateService } from '../../../../../services/flow/workflow-state.service';
import { FileSystemService } from '../../../../../services/operations/file-system.service';
import { CronSummaryCardComponent } from './cron-summary-card.component';

import { PillDirective } from '../../../../../shared/directives/pill.directive';

type ConditionPreset =
  'has_diff' | 'no_diff' | 'diff_count' | 'has_errors' | 'transferred' | 'script_success';

/** What each quick condition checks on the previous node's output. */
const CONDITION_PRESETS: Record<
  ConditionPreset,
  { field: string; operator: string; rightValue: string }
> = {
  has_diff: { field: 'hasDifferences', operator: 'equals', rightValue: 'true' },
  no_diff: { field: 'hasDifferences', operator: 'equals', rightValue: 'false' },
  diff_count: { field: 'differCount', operator: 'greater_than', rightValue: '0' },
  has_errors: { field: 'errors', operator: 'greater_than', rightValue: '0' },
  transferred: { field: 'bytes', operator: 'greater_than', rightValue: '0' },
  script_success: { field: 'exitCode', operator: 'equals', rightValue: '0' },
};

/** The settings that make a condition read `field` of a node (`prev` is the node before it). */
function leftOperand(nodeId: string, field: string): Record<string, string> {
  return {
    leftNodeId: nodeId,
    leftField: field,
    leftValue: nodeId === 'prev' ? `{{prev.${field}}}` : `{{nodes.${nodeId}.${field}}}`,
  };
}

@Component({
  selector: 'app-logic-node-form',
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatOptionModule,
    TranslatePipe,
    AlertBannerComponent,
    CronSummaryCardComponent,
    PillDirective,
  ],
  templateUrl: './logic-node-form.component.html',
  styleUrls: ['../workflow-inspector.component.scss', './logic-node-form.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogicNodeFormComponent {
  private readonly stateService = inject(WorkflowStateService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly translate = inject(TranslateService);

  readonly node = input.required<WorkflowNode>();
  readonly nodeConfig = input.required<Record<string, unknown>>();
  readonly openDetailed = output<void>();

  private readonly langChange = toSignal(this.translate.onLangChange);
  private readonly cron = computed(() => {
    this.langChange();
    const expr = String(this.nodeConfig()['cronExpression'] || '').trim();
    return describeCron(expr, this.translate.getCurrentLang());
  });
  readonly isCronInvalid = computed(() => this.cron().isInvalid);
  readonly cronHumanReadable = computed(() =>
    this.cron().isInvalid
      ? this.translate.instant('flow.workflow.inspector.invalidCron')
      : this.cron().text
  );

  readonly delaySecondsValue = computed(() => {
    const val = this.nodeConfig()['delaySeconds'];
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const parsed = Number(val);
      if (!isNaN(parsed)) return parsed;
    }
    return 5;
  });

  readonly isUnaryConditionOperator = computed(() => {
    const op = (this.nodeConfig()['operator'] as string) || 'equals';
    return (
      op === 'truthy' ||
      op === 'is_empty' ||
      op === 'file_exists' ||
      op === 'array_not_empty' ||
      op === 'array_is_empty'
    );
  });

  readonly isFileExistsConditionOperator = computed(() => {
    return (this.nodeConfig()['operator'] as string) === 'file_exists';
  });

  readonly availableUpstreamNodes = computed<WorkflowNode[]>(() => {
    return getAvailableUpstreamNodes(this.stateService.currentWorkflow(), this.node().id);
  });

  readonly conditionLeftValueMode = computed<'node' | 'custom'>(() => {
    const cfg = this.nodeConfig();
    if (cfg['leftMode'] === 'custom' || cfg['leftMode'] === 'node') {
      return cfg['leftMode'];
    }
    const left = typeof cfg['leftValue'] === 'string' ? cfg['leftValue'].trim() : '';
    if ((left.startsWith('{{nodes.') || left.startsWith('{{prev.')) && left.endsWith('}}')) {
      return 'node';
    }
    if (left && !left.startsWith('{{')) {
      return 'custom';
    }
    return this.availableUpstreamNodes().length > 0 ? 'node' : 'custom';
  });

  readonly conditionTargetNodeId = computed<string>(() => {
    const cfg = this.nodeConfig();
    if (typeof cfg['leftNodeId'] === 'string' && cfg['leftNodeId']) {
      return cfg['leftNodeId'];
    }
    const left = typeof cfg['leftValue'] === 'string' ? cfg['leftValue'].trim() : '';
    const match = left.match(/^\{\{nodes\.([^.]+)\.([^}]+)\}\}$/);
    if (match) {
      return match[1];
    }
    const prevMatch = left.match(/^\{\{prev\.([^}]+)\}\}$/);
    if (prevMatch) {
      return 'prev';
    }
    return this.availableUpstreamNodes()[0]?.id || '';
  });

  readonly availableNodeFields = computed<NodeVariableField[]>(() => {
    const targetId = this.conditionTargetNodeId();
    if (targetId === 'prev') {
      return getPreviousNodeFields(this.stateService.currentWorkflow(), this.node().id);
    }
    const targetNode = this.availableUpstreamNodes().find(n => n.id === targetId);
    return targetNode ? getNodeFields(targetNode) : [];
  });

  readonly conditionTargetField = computed<string>(() => {
    const cfg = this.nodeConfig();
    if (typeof cfg['leftField'] === 'string' && cfg['leftField']) {
      return cfg['leftField'];
    }
    const left = typeof cfg['leftValue'] === 'string' ? cfg['leftValue'].trim() : '';
    const match = left.match(/^\{\{nodes\.([^.]+)\.([^}]+)\}\}$/);
    if (match) {
      return match[2];
    }
    const prevMatch = left.match(/^\{\{prev\.([^}]+)\}\}$/);
    if (prevMatch) {
      return prevMatch[1];
    }
    return this.availableNodeFields()[0]?.key || 'status';
  });

  readonly configChange = output<{ key: string; value: unknown }>();
  /** Several settings changed together: one undo step. */
  readonly configPatch = output<Record<string, unknown>>();

  setConditionLeftValueMode(mode: 'node' | 'custom'): void {
    if (mode === 'custom') {
      this.configChange.emit({ key: 'leftMode', value: mode });
      return;
    }
    // `prev` is always on offer, so there is always a node to read from.
    this.configPatch.emit({
      leftMode: mode,
      ...leftOperand(this.conditionTargetNodeId(), this.conditionTargetField()),
    });
  }

  onConditionTargetNodeChange(nodeId: string): void {
    const targetNode = this.availableUpstreamNodes().find(n => n.id === nodeId);
    const field =
      nodeId === 'prev'
        ? 'hasDifferences'
        : (targetNode && getNodeFields(targetNode)[0]?.key) || 'status';
    this.configPatch.emit(leftOperand(nodeId, field));
  }

  onConditionTargetFieldChange(field: string, targetNodeId?: string): void {
    const nodeId = targetNodeId || this.conditionTargetNodeId();
    this.configPatch.emit(nodeId ? leftOperand(nodeId, field) : { leftField: field });
  }

  onFieldChange(key: string, value: unknown): void {
    this.configChange.emit({ key, value });
  }

  async browseConditionFilePath(): Promise<void> {
    try {
      const path = await this.fileSystemService.selectFile();
      if (path) {
        this.onFieldChange('leftValue', path);
      }
    } catch {
      // user cancelled
    }
  }

  applyConditionPreset(preset: ConditionPreset): void {
    const { field, operator, rightValue } = CONDITION_PRESETS[preset];
    this.configPatch.emit({
      leftMode: 'node',
      ...leftOperand('prev', field),
      operator,
      rightValue,
    });
  }

  addInputBranch(): void {
    this.stateService.addJoinInputPort(this.node().id);
  }

  removeInputBranch(portId?: string): void {
    this.stateService.removeJoinInputPort(this.node().id, portId);
  }

  addOutputBranch(): void {
    this.stateService.addForkOutputPort(this.node().id);
  }

  removeOutputBranch(portId?: string): void {
    this.stateService.removeForkOutputPort(this.node().id, portId);
  }
}

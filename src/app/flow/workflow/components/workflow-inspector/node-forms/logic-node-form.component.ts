import { Component, ChangeDetectionStrategy, computed, inject, input, output } from '@angular/core';
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
import { toString as cronstrue } from 'cronstrue';
import { getCronstrueLocale } from '../../../../../services/i18n/cron-locale.mapper';
import { WorkflowNode } from '../../../types/workflow.types';
import {
  getAvailableUpstreamNodes,
  getNodeFields,
  getNodeFieldsForType,
  NodeVariableField,
} from '../../../utils/node-fields.util';
import { AlertBannerComponent } from '../../../../../shared/components/alert-banner/alert-banner.component';
import { WorkflowStateService } from '../../../../../services/flow/workflow-state.service';
import { FileSystemService } from '../../../../../services/operations/file-system.service';

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
  ],
  templateUrl: './logic-node-form.component.html',
  styleUrls: ['../workflow-inspector.component.scss', './logic-node-form.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogicNodeFormComponent {
  private readonly stateService = inject(WorkflowStateService);
  private readonly fileSystemService = inject(FileSystemService, { optional: true });
  private readonly translate = inject(TranslateService);

  readonly node = input.required<WorkflowNode>();
  readonly nodeConfig = input.required<Record<string, unknown>>();
  readonly openDetailed = output<void>();

  readonly cronScheduleInfo = computed(() => {
    const expr = String(this.nodeConfig()['cronExpression'] || '').trim();
    if (!expr) {
      return { text: '', isInvalid: false };
    }
    try {
      const text = cronstrue(expr, {
        locale: getCronstrueLocale(this.translate.getCurrentLang() ?? 'en-US'),
        throwExceptionOnParseError: true,
      });
      return { text, isInvalid: false };
    } catch {
      return {
        text: this.translate.instant('flow.workflow.inspector.invalidCron'),
        isInvalid: true,
      };
    }
  });

  readonly isCronInvalid = computed(() => this.cronScheduleInfo().isInvalid);
  readonly cronHumanReadable = computed(() => this.cronScheduleInfo().text);

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
    return getAvailableUpstreamNodes(this.stateService.currentWorkflow()?.nodes, this.node().id);
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
    const wf = this.stateService.currentWorkflow();
    if (targetId === 'prev') {
      const incomingEdge = wf?.edges?.find(e => e.targetNodeId === this.node().id);
      const upstreamNode = incomingEdge
        ? wf?.nodes?.find(n => n.id === incomingEdge.sourceNodeId)
        : undefined;
      if (upstreamNode) {
        return getNodeFields(upstreamNode);
      }
      return getNodeFieldsForType('prev');
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

  setConditionLeftValueMode(mode: 'node' | 'custom'): void {
    this.configChange.emit({ key: 'leftMode', value: mode });
    if (mode === 'node') {
      const nodes = this.availableUpstreamNodes();
      if (nodes.length > 0) {
        const nodeId = this.conditionTargetNodeId() || nodes[0].id;
        const fields = this.availableNodeFields();
        const field = this.conditionTargetField() || fields[0]?.key || 'status';
        const leftValue = nodeId === 'prev' ? `{{prev.${field}}}` : `{{nodes.${nodeId}.${field}}}`;
        this.configChange.emit({ key: 'leftNodeId', value: nodeId });
        this.configChange.emit({ key: 'leftField', value: field });
        this.configChange.emit({ key: 'leftValue', value: leftValue });
      }
    }
  }

  onConditionTargetNodeChange(nodeId: string): void {
    this.configChange.emit({ key: 'leftNodeId', value: nodeId });
    let field: string;
    if (nodeId === 'prev') {
      field = 'hasDifferences';
    } else {
      const targetNode = this.availableUpstreamNodes().find(n => n.id === nodeId);
      const fields = targetNode ? getNodeFields(targetNode) : [];
      field = fields[0]?.key || 'status';
    }
    const leftValue = nodeId === 'prev' ? `{{prev.${field}}}` : `{{nodes.${nodeId}.${field}}}`;
    this.configChange.emit({ key: 'leftField', value: field });
    this.configChange.emit({ key: 'leftValue', value: leftValue });
  }

  onConditionTargetFieldChange(field: string, targetNodeId?: string): void {
    this.configChange.emit({ key: 'leftField', value: field });
    const nodeId = targetNodeId || this.conditionTargetNodeId();
    if (nodeId) {
      const leftValue = nodeId === 'prev' ? `{{prev.${field}}}` : `{{nodes.${nodeId}.${field}}}`;
      this.configChange.emit({ key: 'leftValue', value: leftValue });
    }
  }

  onFieldChange(key: string, value: unknown): void {
    this.configChange.emit({ key, value });
  }

  async browseConditionFilePath(): Promise<void> {
    if (!this.fileSystemService) return;
    try {
      const path = await this.fileSystemService.selectFile();
      if (path) {
        this.onFieldChange('leftValue', path);
      }
    } catch {
      // user cancelled
    }
  }

  applyDelayPreset(seconds: number): void {
    this.onFieldChange('delaySeconds', seconds);
  }

  applyConditionPreset(
    preset: 'has_diff' | 'no_diff' | 'diff_count' | 'has_errors' | 'transferred' | 'script_success'
  ): void {
    let field = 'hasDifferences';
    let operator = 'equals';
    let rightValue = 'true';

    switch (preset) {
      case 'has_diff':
        field = 'hasDifferences';
        operator = 'equals';
        rightValue = 'true';
        break;
      case 'no_diff':
        field = 'hasDifferences';
        operator = 'equals';
        rightValue = 'false';
        break;
      case 'diff_count':
        field = 'differCount';
        operator = 'greater_than';
        rightValue = '0';
        break;
      case 'has_errors':
        field = 'errors';
        operator = 'greater_than';
        rightValue = '0';
        break;
      case 'transferred':
        field = 'bytes';
        operator = 'greater_than';
        rightValue = '0';
        break;
      case 'script_success':
        field = 'exitCode';
        operator = 'equals';
        rightValue = '0';
        break;
    }

    this.configChange.emit({ key: 'leftMode', value: 'node' });
    this.configChange.emit({ key: 'leftNodeId', value: 'prev' });
    this.configChange.emit({ key: 'leftField', value: field });
    this.configChange.emit({ key: 'leftValue', value: `{{prev.${field}}}` });
    this.configChange.emit({ key: 'operator', value: operator });
    this.configChange.emit({ key: 'rightValue', value: rightValue });
  }

  addInputBranch(): void {
    this.stateService.addJoinInputPort(this.node().id);
  }

  removeInputBranch(portId?: string): void {
    this.stateService.removeJoinInputPort(this.node().id, portId);
  }

  canRemoveBranch(): boolean {
    const inputs = this.node().inputs || [];
    return inputs.length > 2;
  }

  addOutputBranch(): void {
    this.stateService.addForkOutputPort(this.node().id);
  }

  removeOutputBranch(portId?: string): void {
    this.stateService.removeForkOutputPort(this.node().id, portId);
  }

  canRemoveOutputBranch(): boolean {
    const outputs = this.node().outputs || [];
    return outputs.length > 2;
  }
}

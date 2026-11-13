import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  computed,
  inject,
  signal,
  OnInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatOptionModule } from '@angular/material/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { WorkflowNode } from '../../../types/workflow.types';
import { AlertService } from '../../../../../services/alerts/alert.service';
import { ModalService } from '../../../../../services/ui/modal.service';
import { AlertAction, AlertActionKind } from '@app/types';
import { AlertBannerComponent } from '../../../../../shared/components/alert-banner/alert-banner.component';
import { FileSystemService } from '../../../../../services/operations/file-system.service';
import { WorkflowStateService } from '../../../../../services/flow/workflow-state.service';
import {
  getAvailableUpstreamNodes,
  getNodeFields,
  getPreviousNode,
  getPreviousNodeFields,
  NodeVariableField,
} from '../../../utils/node-fields.util';

import { PillDirective } from '../../../../../shared/directives/pill.directive';

/** The quick messages of a notification: the text lives under `flow.workflow.inspector.presets.<text>Title/Msg`. */
const NOTIFICATION_PRESETS = {
  check_report: { text: 'checkReport', severity: 'warning' },
  transfer_summary: { text: 'transferSummary', severity: 'info' },
  failure_alert: { text: 'failureAlert', severity: 'error' },
  health_status: { text: 'healthStatus', severity: 'info' },
} as const;

@Component({
  selector: 'app-action-node-form',
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatOptionModule,
    MatButtonToggleModule,
    MatButtonModule,
    TranslatePipe,
    AlertBannerComponent,
    PillDirective,
  ],
  templateUrl: './action-node-form.component.html',
  styleUrl: './action-node-form.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActionNodeFormComponent implements OnInit {
  public readonly alertService = inject(AlertService);
  public readonly translate = inject(TranslateService);
  private readonly modalService = inject(ModalService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly workflowState = inject(WorkflowStateService);

  readonly node = input.required<WorkflowNode>();
  readonly nodeConfig = input.required<Record<string, unknown>>();
  readonly availableMountNodes = input<WorkflowNode[]>([]);
  readonly availableServeNodes = input<WorkflowNode[]>([]);

  readonly configChange = output<{ key: string; value: unknown }>();
  /** Several settings changed together: one undo step. */
  readonly configPatch = output<Record<string, unknown>>();

  readonly templateKeys = signal<string[]>([
    'profile',
    'operation',
    'severity',
    'remote',
    'timestamp',
    'title',
    'body',
  ]);

  readonly quickOutputTokens = signal<string[]>([
    'prev.summary',
    'prev.report',
    'prev.differ',
    'prev.bytesFormatted',
    'prev.error',
  ]);

  readonly upstreamNodes = computed<WorkflowNode[]>(() => {
    return getAvailableUpstreamNodes(this.workflowState.currentWorkflow(), this.node().id);
  });

  readonly selectedVariableNodeId = signal<string>('prev');
  readonly selectedVariableField = signal<string>('summary');

  readonly availableFieldsForSelectedNode = computed<NodeVariableField[]>(() => {
    const targetId = this.selectedVariableNodeId();
    if (targetId === 'prev') {
      return getPreviousNodeFields(this.workflowState.currentWorkflow(), this.node().id);
    }
    const target = this.upstreamNodes().find(n => n.id === targetId);
    return target ? getNodeFields(target) : [];
  });

  readonly previewMessage = computed<string>(() => {
    const raw = (this.nodeConfig()['message'] as string) || '';
    if (!raw) return '';

    const wf = this.workflowState.currentWorkflow();
    const lastOutput =
      (getPreviousNode(wf, this.node().id)?.lastOutput as Record<string, unknown>) || {};

    return raw.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, token) => {
      const trimmed = token.trim();
      if (trimmed.startsWith('prev.') || trimmed.startsWith('previous.')) {
        const field = trimmed.replace(/^prev\.|^previous\./, '');
        if (lastOutput[field] !== undefined && lastOutput[field] !== null) {
          const val = lastOutput[field];
          return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
        }
        return match;
      }
      if (trimmed.startsWith('nodes.') || trimmed.startsWith('steps.')) {
        const rawPath = trimmed.replace(/^(nodes|steps)\./, '');
        const [nodeId, ...fieldParts] = rawPath.split('.');
        const field = fieldParts.join('.');
        const targetNode = wf?.nodes?.find(n => n.id === nodeId || n.title === nodeId);
        const nodeOutput = (targetNode?.lastOutput as Record<string, unknown>) || {};
        if (nodeOutput[field] !== undefined && nodeOutput[field] !== null) {
          const val = nodeOutput[field];
          return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
        }
      }
      return match;
    });
  });

  readonly selectedAction = computed<AlertAction | undefined>(() => {
    const actionId = this.nodeConfig()['actionId'] as string | undefined;
    const actions = this.alertService.actions();
    if (actionId) {
      return actions.find(a => a.id === actionId);
    }
    return actions.length > 0 ? actions[0] : undefined;
  });

  /** Whether the target is a node of the workflow or typed in; older settings only hold the typed one. */
  private targetModeOf(typedKey: 'mountPoint' | 'serverId'): 'node' | 'custom' {
    const cfg = this.nodeConfig();
    if (cfg['targetMode'] === 'custom' || cfg['targetMode'] === 'node') {
      return cfg['targetMode'];
    }
    return cfg[typedKey] && !cfg['targetNodeId'] ? 'custom' : 'node';
  }

  readonly unmountTargetMode = computed(() => this.targetModeOf('mountPoint'));
  readonly stopServeTargetMode = computed(() => this.targetModeOf('serverId'));

  ngOnInit(): void {
    this.alertService
      .getTemplateKeys()
      .then(keys => {
        if (keys && keys.length > 0) {
          this.templateKeys.set(keys);
        }
      })
      .catch(() => {
        // Fallback default keys remain
      });
  }

  onActionSelect(actionId: string): void {
    const selected = this.alertService.actions().find(a => a.id === actionId);
    this.configPatch.emit({
      actionId,
      ...(selected && { actionKind: selected.kind, icon: this.getActionIcon(selected.kind) }),
    });
  }

  getActionIcon(kind?: string): string {
    return (kind && this.alertService.getActionIcon(kind as AlertActionKind)) || 'bell';
  }

  /** The one thing that tells an action of its kind apart from the others. */
  getActionDetail(action: AlertAction): string {
    switch (action.kind) {
      case 'webhook':
        return `${action.method || 'POST'} ${action.url}`;
      case 'telegram':
        return action.chat_id || '';
      case 'whatsapp':
        return action.phone || '';
      case 'script':
        return action.command || '';
      case 'mqtt':
        return action.topic || '';
      case 'email':
        return action.to || '';
      default:
        return '';
    }
  }

  insertVariableToken(token: string, targetField: 'title' | 'message' = 'message'): void {
    const current = (this.nodeConfig()[targetField] as string) || '';
    const tag = `{{${token}}}`;
    const updated = current ? `${current} ${tag}` : tag;
    this.onFieldChange(targetField, updated);
  }

  insertUpstreamToken(): void {
    const nId = this.selectedVariableNodeId();
    const fKey = this.selectedVariableField();
    if (!nId || !fKey) return;
    const token = nId === 'prev' ? `prev.${fKey}` : `nodes.${nId}.${fKey}`;
    this.insertVariableToken(token);
  }

  openAlertsModal(): void {
    this.modalService.openAlerts();
  }

  setUnmountTargetMode(mode: 'node' | 'custom'): void {
    this.setTargetMode(mode, 'mountPoint', this.availableMountNodes());
  }

  setStopServeTargetMode(mode: 'node' | 'custom'): void {
    this.setTargetMode(mode, 'serverId', this.availableServeNodes());
  }

  /** Switching to a node clears the typed target and picks the first node; switching back clears the node. */
  private setTargetMode(
    mode: 'node' | 'custom',
    typedKey: 'mountPoint' | 'serverId',
    nodes: WorkflowNode[]
  ): void {
    if (mode === 'custom') {
      this.configPatch.emit({ targetMode: mode, targetNodeId: '' });
      return;
    }
    const pickFirst = !this.nodeConfig()['targetNodeId'] && nodes.length > 0;
    this.configPatch.emit({
      targetMode: mode,
      [typedKey]: '',
      ...(pickFirst && { targetNodeId: nodes[0].id }),
    });
  }

  async browseUnmountFolder(): Promise<void> {
    try {
      const path = await this.fileSystemService.selectFolder();
      if (path) {
        this.onFieldChange('mountPoint', path);
      }
    } catch {
      // user cancelled
    }
  }

  onFieldChange(key: string, value: unknown): void {
    this.configChange.emit({ key, value });
  }

  applyNotificationPreset(preset: keyof typeof NOTIFICATION_PRESETS): void {
    const { text, severity } = NOTIFICATION_PRESETS[preset];
    this.configPatch.emit({
      title: this.translate.instant(`flow.workflow.inspector.presets.${text}Title`),
      message: this.translate.instant(`flow.workflow.inspector.presets.${text}Msg`),
      severity,
    });
  }
}

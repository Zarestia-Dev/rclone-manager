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
  getNodeFieldsForType,
  NodeVariableField,
} from '../../../utils/node-fields.util';

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
  ],
  templateUrl: './action-node-form.component.html',
  styleUrl: './action-node-form.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActionNodeFormComponent implements OnInit {
  public readonly alertService = inject(AlertService);
  public readonly translate = inject(TranslateService);
  private readonly modalService = inject(ModalService);
  private readonly fileSystemService = inject(FileSystemService, { optional: true });
  private readonly workflowState = inject(WorkflowStateService, { optional: true });

  readonly node = input.required<WorkflowNode>();
  readonly nodeConfig = input.required<Record<string, unknown>>();
  readonly availableMountNodes = input<WorkflowNode[]>([]);
  readonly availableServeNodes = input<WorkflowNode[]>([]);

  readonly configChange = output<{ key: string; value: unknown }>();

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
    return getAvailableUpstreamNodes(this.workflowState?.currentWorkflow()?.nodes, this.node().id);
  });

  readonly selectedVariableNodeId = signal<string>('prev');
  readonly selectedVariableField = signal<string>('summary');

  readonly availableFieldsForSelectedNode = computed<NodeVariableField[]>(() => {
    const targetId = this.selectedVariableNodeId();
    const wf = this.workflowState?.currentWorkflow();
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
    const target = this.upstreamNodes().find(n => n.id === targetId);
    return target ? getNodeFields(target) : [];
  });

  readonly previewMessage = computed<string>(() => {
    const raw = (this.nodeConfig()['message'] as string) || '';
    if (!raw) return '';

    const wf = this.workflowState?.currentWorkflow();
    const incomingEdge = wf?.edges?.find(e => e.targetNodeId === this.node().id);
    const upstreamNode = incomingEdge
      ? wf?.nodes?.find(n => n.id === incomingEdge.sourceNodeId)
      : undefined;
    const lastOutput = (upstreamNode?.lastOutput as Record<string, unknown>) || {};

    return raw.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, token) => {
      const trimmed = token.trim();
      if (trimmed.startsWith('prev.') || trimmed.startsWith('previous.')) {
        const field = trimmed.replace(/^prev\.|^previous\./, '');
        if (lastOutput[field] !== undefined && lastOutput[field] !== null) {
          const val = lastOutput[field];
          return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
        }
        switch (field) {
          case 'bytesFormatted':
            return '1.45 GiB';
          case 'speedFormatted':
            return '45.2 MiB/s';
          case 'transfers':
            return '12';
          case 'errors':
            return '0';
          case 'status':
            return 'success';
          case 'summary':
            return 'Transfer completed: 1.45 GiB in 12 files (0 errors)';
          case 'report':
            return '### Check Report\n- **Status**: Differences detected (2 files)\n- **Differing Files (2)**:\n  • photos/vacation.jpg\n  • docs/report.pdf';
          case 'error':
            return 'Failed to connect to host: connection refused';
          default:
            return match;
        }
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

  readonly unmountTargetMode = computed<'node' | 'custom'>(() => {
    const cfg = this.nodeConfig();
    if (cfg['targetMode'] === 'custom' || cfg['targetMode'] === 'node') {
      return cfg['targetMode'];
    }
    return cfg['mountPoint'] && !cfg['targetNodeId'] ? 'custom' : 'node';
  });

  readonly stopServeTargetMode = computed<'node' | 'custom'>(() => {
    const cfg = this.nodeConfig();
    if (cfg['targetMode'] === 'custom' || cfg['targetMode'] === 'node') {
      return cfg['targetMode'];
    }
    return cfg['serverId'] && !cfg['targetNodeId'] ? 'custom' : 'node';
  });

  ngOnInit(): void {
    if (typeof this.alertService?.getTemplateKeys === 'function') {
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
  }

  onActionSelect(actionId: string): void {
    this.configChange.emit({ key: 'actionId', value: actionId });
    const selected = this.alertService.actions().find(a => a.id === actionId);
    if (selected) {
      this.configChange.emit({ key: 'actionKind', value: selected.kind });
      this.configChange.emit({ key: 'icon', value: this.getActionIcon(selected.kind) });
    }
  }

  getActionIcon(kind?: string): string {
    return (kind && this.alertService.getActionIcon(kind as AlertActionKind)) || 'bell';
  }

  getActionDetail(action: AlertAction): string {
    switch (action.kind) {
      case 'webhook':
        return `${action.method || 'POST'} ${action.url}`;
      case 'telegram':
        return `Chat ID: ${action.chat_id || 'N/A'}`;
      case 'whatsapp':
        return `Phone: ${action.phone || 'N/A'}`;
      case 'script':
        return action.command || '';
      case 'mqtt':
        return `Topic: ${action.topic || 'N/A'}`;
      case 'email':
        return `To: ${action.to || 'N/A'}`;
      case 'os_toast':
        return 'System Desktop Notification';
      default:
        return '';
    }
  }

  insertTemplateVariable(key: string): void {
    this.insertVariableToken(key);
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
    this.configChange.emit({ key: 'targetMode', value: mode });
    if (mode === 'node') {
      this.configChange.emit({ key: 'mountPoint', value: '' });
      if (!this.nodeConfig()['targetNodeId'] && this.availableMountNodes().length > 0) {
        this.configChange.emit({ key: 'targetNodeId', value: this.availableMountNodes()[0].id });
      }
    } else {
      this.configChange.emit({ key: 'targetNodeId', value: '' });
    }
  }

  async browseUnmountFolder(): Promise<void> {
    if (!this.fileSystemService) return;
    try {
      const path = await this.fileSystemService.selectFolder();
      if (path) {
        this.onFieldChange('mountPoint', path);
      }
    } catch {
      // user cancelled
    }
  }

  setStopServeTargetMode(mode: 'node' | 'custom'): void {
    this.configChange.emit({ key: 'targetMode', value: mode });
    if (mode === 'node') {
      this.configChange.emit({ key: 'serverId', value: '' });
      if (!this.nodeConfig()['targetNodeId'] && this.availableServeNodes().length > 0) {
        this.configChange.emit({ key: 'targetNodeId', value: this.availableServeNodes()[0].id });
      }
    } else {
      this.configChange.emit({ key: 'targetNodeId', value: '' });
    }
  }

  onFieldChange(key: string, value: unknown): void {
    this.configChange.emit({ key, value });
  }

  private getLocalizedPresetText(key: string, fallback: string): string {
    const res = this.translate.instant(key);
    return res && res !== key ? res : fallback;
  }

  applyNotificationPreset(
    preset: 'check_report' | 'transfer_summary' | 'failure_alert' | 'health_status'
  ): void {
    switch (preset) {
      case 'check_report':
        this.onFieldChange(
          'title',
          this.getLocalizedPresetText(
            'flow.workflow.inspector.presets.checkReportTitle',
            'Difference Detected (Check Audit)'
          )
        );
        this.onFieldChange(
          'message',
          this.getLocalizedPresetText(
            'flow.workflow.inspector.presets.checkReportMsg',
            '⚠️ Differences found between source and destination:\n\n{{prev.report}}'
          )
        );
        this.onFieldChange('severity', 'warning');
        break;
      case 'transfer_summary':
        this.onFieldChange(
          'title',
          this.getLocalizedPresetText(
            'flow.workflow.inspector.presets.transferSummaryTitle',
            'Sync Completed Successfully'
          )
        );
        this.onFieldChange(
          'message',
          this.getLocalizedPresetText(
            'flow.workflow.inspector.presets.transferSummaryMsg',
            '✅ Daily backup finished:\nTransferred: {{prev.bytesFormatted}}\nFiles: {{prev.transfers}}\nSpeed: {{prev.speedFormatted}}\nErrors: {{prev.errors}}'
          )
        );
        this.onFieldChange('severity', 'info');
        break;
      case 'failure_alert':
        this.onFieldChange(
          'title',
          this.getLocalizedPresetText(
            'flow.workflow.inspector.presets.failureAlertTitle',
            'Workflow Step Failed'
          )
        );
        this.onFieldChange(
          'message',
          this.getLocalizedPresetText(
            'flow.workflow.inspector.presets.failureAlertMsg',
            '❌ Execution failed on node.\n\nError details:\n{{prev.error}}'
          )
        );
        this.onFieldChange('severity', 'error');
        break;
      case 'health_status':
        this.onFieldChange(
          'title',
          this.getLocalizedPresetText(
            'flow.workflow.inspector.presets.healthStatusTitle',
            'Workflow Execution Report'
          )
        );
        this.onFieldChange(
          'message',
          this.getLocalizedPresetText(
            'flow.workflow.inspector.presets.healthStatusMsg',
            'Workflow step finished with status: {{prev.status}}.\nTransferred: {{prev.bytesFormatted}}'
          )
        );
        this.onFieldChange('severity', 'info');
        break;
    }
  }
}

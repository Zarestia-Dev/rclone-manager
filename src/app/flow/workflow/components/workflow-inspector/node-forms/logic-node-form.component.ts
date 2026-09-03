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
import { TranslatePipe } from '@ngx-translate/core';
import { WorkflowNode } from '../../../types/workflow.types';
import { getNodeFieldsForType } from '../../../utils/node-fields.util';
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
  styleUrl: '../workflow-inspector.component.scss',
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .form-field-full {
        width: 100%;
      }

      .policy-section {
        display: flex;
        flex-direction: column;
        gap: 8px;

        .policy-note {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 8px 10px;
          border-radius: var(--radius-xs, 6px);
          background: rgba(var(--accent-color-rgb, 59, 130, 246), 0.08);
          border: 1px solid rgba(var(--accent-color-rgb, 59, 130, 246), 0.18);
          font-size: 11px;
          line-height: 1.4;
          color: var(--window-fg-color, #e0e0e0);

          mat-icon {
            width: 15px;
            height: 15px;
            font-size: 15px;
            flex-shrink: 0;
            margin-top: 1px;
            color: var(--accent-color, #3b82f6);
          }

          span {
            flex: 1;
          }
        }
      }

      .branches-card {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 12px;
        border-radius: var(--radius-sm, 8px);
        background: var(--bg-elevated-1, rgba(255, 255, 255, 0.03));
        border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));

        .card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;

          .card-title {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--dim-color, #999);
          }

          .card-badge {
            font-size: 11px;
            font-weight: 600;
            padding: 1px 7px;
            border-radius: 999px;
            background: rgba(var(--accent-color-rgb, 59, 130, 246), 0.12);
            color: var(--accent-color, #3b82f6);
            border: 1px solid rgba(var(--accent-color-rgb, 59, 130, 246), 0.25);
          }
        }

        .branches-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .branch-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 10px;
          border-radius: var(--radius-xs, 6px);
          background: var(--bg-elevated-2, rgba(255, 255, 255, 0.06));
          border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
          font-size: 12px;
          font-weight: 500;
          color: var(--window-fg-color, #fff);
          transition:
            background 0.15s ease,
            border-color 0.15s ease;

          &.removable {
            padding-right: 5px;
          }

          .chip-status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--accent-color, #3b82f6);
            box-shadow: 0 0 6px rgba(var(--accent-color-rgb, 59, 130, 246), 0.6);
          }

          .chip-text {
            font-weight: 500;
            line-height: 1;
          }

          .chip-delete-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 18px;
            height: 18px;
            padding: 0;
            border: none;
            border-radius: 50%;
            background: transparent;
            color: var(--dim-color, #999);
            cursor: pointer;
            margin-left: 2px;
            transition: all 0.15s ease;

            mat-icon {
              width: 12px;
              height: 12px;
              font-size: 12px;
            }

            &:hover {
              background: rgba(var(--destructive-color-rgb, 239, 68, 68), 0.2);
              color: var(--destructive-bg-color, #ef4444);
              transform: scale(1.1);
            }
          }
        }

        .add-branch-full-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          width: 100%;
          height: 34px;
          padding: 0 14px;
          border-radius: var(--radius-xs, 6px);
          border: 1px dashed rgba(var(--accent-color-rgb, 59, 130, 246), 0.45);
          background: rgba(var(--accent-color-rgb, 59, 130, 246), 0.05);
          color: var(--accent-color, #3b82f6);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
          transition: all 0.15s ease;

          mat-icon {
            width: 16px;
            height: 16px;
            font-size: 16px;
          }

          &:hover {
            background: rgba(var(--accent-color-rgb, 59, 130, 246), 0.12);
            border-color: var(--accent-color, #3b82f6);
            border-style: solid;
          }

          &:active {
            transform: scale(0.99);
          }
        }
      }

      .presets-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 4px;
      }

      .target-mode-group {
        margin-bottom: 4px;

        mat-button-toggle-group {
          width: 100%;
          display: flex;

          mat-button-toggle {
            flex: 1;
            font-size: 0.82rem;
          }
        }
      }

      .token-preview {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: var(--radius-xs, 6px);
        background: rgba(var(--accent-color-rgb, 59, 130, 246), 0.08);
        border: 1px dashed rgba(var(--accent-color-rgb, 59, 130, 246), 0.25);
        font-size: 0.8rem;
        color: var(--text-secondary, #a0a0a0);

        .token-label {
          font-weight: 500;
        }

        code {
          font-family: var(--font-mono, monospace);
          font-size: 0.82rem;
          color: var(--accent-color, #3b82f6);
          word-break: break-all;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogicNodeFormComponent {
  private readonly stateService = inject(WorkflowStateService);
  private readonly fileSystemService = inject(FileSystemService, { optional: true });

  readonly node = input.required<WorkflowNode>();
  readonly nodeConfig = input.required<Record<string, unknown>>();

  readonly delaySecondsValue = computed(() => {
    const val = this.nodeConfig()['seconds'];
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const parsed = Number(val);
      if (!isNaN(parsed)) return parsed;
    }
    return 5;
  });

  readonly isUnaryConditionOperator = computed(() => {
    const op = (this.nodeConfig()['operator'] as string) || 'equals';
    return op === 'truthy' || op === 'is_empty' || op === 'file_exists';
  });

  readonly isFileExistsConditionOperator = computed(() => {
    return (this.nodeConfig()['operator'] as string) === 'file_exists';
  });

  readonly availableUpstreamNodes = computed<WorkflowNode[]>(() => {
    const wf = this.stateService.currentWorkflow();
    if (!wf?.nodes) return [];
    return wf.nodes.filter(n => n.id !== this.node().id);
  });

  readonly conditionLeftValueMode = computed<'node' | 'custom'>(() => {
    const cfg = this.nodeConfig();
    if (cfg['leftMode'] === 'custom' || cfg['leftMode'] === 'node') {
      return cfg['leftMode'];
    }
    const left = typeof cfg['leftValue'] === 'string' ? cfg['leftValue'].trim() : '';
    if (left.startsWith('{{nodes.') && left.endsWith('}}')) {
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
    return this.availableUpstreamNodes()[0]?.id || '';
  });

  readonly availableNodeFields = computed<{ key: string; label: string }[]>(() => {
    const targetId = this.conditionTargetNodeId();
    const targetNode = this.availableUpstreamNodes().find(n => n.id === targetId);
    return this.getNodeFieldsForType(targetNode?.type);
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
    return this.availableNodeFields()[0]?.key || 'status';
  });

  readonly configChange = output<{ key: string; value: unknown }>();

  getNodeFieldsForType(type?: string): { key: string; label: string }[] {
    return getNodeFieldsForType(type);
  }

  setConditionLeftValueMode(mode: 'node' | 'custom'): void {
    this.configChange.emit({ key: 'leftMode', value: mode });
    if (mode === 'node') {
      const nodes = this.availableUpstreamNodes();
      if (nodes.length > 0) {
        const nodeId = this.conditionTargetNodeId() || nodes[0].id;
        const fields = this.getNodeFieldsForType(nodes.find(n => n.id === nodeId)?.type);
        const field = this.conditionTargetField() || fields[0]?.key || 'status';
        this.configChange.emit({ key: 'leftNodeId', value: nodeId });
        this.configChange.emit({ key: 'leftField', value: field });
        this.configChange.emit({ key: 'leftValue', value: `{{nodes.${nodeId}.${field}}}` });
      }
    }
  }

  onConditionTargetNodeChange(nodeId: string): void {
    this.configChange.emit({ key: 'leftNodeId', value: nodeId });
    const targetNode = this.availableUpstreamNodes().find(n => n.id === nodeId);
    const fields = this.getNodeFieldsForType(targetNode?.type);
    const field = fields[0]?.key || 'status';
    this.configChange.emit({ key: 'leftField', value: field });
    this.configChange.emit({ key: 'leftValue', value: `{{nodes.${nodeId}.${field}}}` });
  }

  onConditionTargetFieldChange(field: string, targetNodeId?: string): void {
    this.configChange.emit({ key: 'leftField', value: field });
    const nodeId = targetNodeId || this.conditionTargetNodeId();
    if (nodeId) {
      this.configChange.emit({ key: 'leftValue', value: `{{nodes.${nodeId}.${field}}}` });
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
    this.onFieldChange('seconds', seconds);
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

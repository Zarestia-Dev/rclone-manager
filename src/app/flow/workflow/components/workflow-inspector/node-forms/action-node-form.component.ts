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
import { TranslatePipe } from '@ngx-translate/core';
import { WorkflowNode } from '../../../types/workflow.types';
import { AlertService } from '../../../../../services/alerts/alert.service';
import { ModalService } from '../../../../../services/ui/modal.service';
import { AlertAction, AlertActionKind } from '@app/types';
import { AlertBannerComponent } from '../../../../../shared/components/alert-banner/alert-banner.component';
import { FileSystemService } from '../../../../../services/operations/file-system.service';

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
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .action-option-item {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        mat-icon {
          width: 18px;
          height: 18px;
          font-size: 18px;
        }
        .action-kind-tag {
          font-size: 0.8em;
          opacity: 0.65;
          text-transform: uppercase;
        }
      }

      .action-summary-card {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px 12px;
        background: var(--bg-elevated);
        border-radius: var(--radius-xs);
        border: 1px solid var(--border-color);

        .summary-header {
          display: flex;
          align-items: center;
          gap: 8px;

          mat-icon {
            width: 16px;
            height: 16px;
            font-size: 16px;
            color: var(--accent-color);
          }

          .action-name {
            font-weight: 600;
            font-size: 0.85rem;
            flex: 1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .action-kind-pill {
            font-size: 0.72rem;
            text-transform: uppercase;
            padding: 1px 6px;
            border-radius: var(--radius-xxs);
            background: rgba(var(--accent-color-rgb), 0.15);
            color: var(--accent-color);
            font-weight: 600;
          }
        }

        .summary-detail {
          font-size: 0.78rem;
          color: var(--dim-color);
          font-family: var(--font-mono);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      }

      .tags-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .tag-btn {
        background: var(--hover-bg-color);
        border: 1px solid var(--border-color);
        padding: 2px 6px;
        border-radius: var(--radius-xxs);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        transition: var(--transition-fast);

        code {
          font-family: var(--font-mono);
          font-size: 0.8rem;
          color: var(--accent-color);
        }

        &:hover {
          background: var(--selected-bg-color);
          border-color: var(--accent-color);
        }
      }

      .code-font {
        font-family: var(--font-mono) !important;
        font-size: 0.88rem !important;
      }

      .empty-actions-hint {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 8px;
        padding: 12px;
        border-radius: var(--radius-sm);
        background: var(--bg-elevated);
        border: 1px solid var(--border-color);

        mat-icon {
          opacity: 0.5;
        }

        .hint-text {
          font-size: 0.85rem;
          color: var(--dim-color);
        }
      }
    `,
  ],
})
export class ActionNodeFormComponent implements OnInit {
  public readonly alertService = inject(AlertService);
  private readonly modalService = inject(ModalService);
  private readonly fileSystemService = inject(FileSystemService, { optional: true });

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
    const current = (this.nodeConfig()['message'] as string) || '';
    const tag = `{{${key}}}`;
    const updated = current ? `${current} ${tag}` : tag;
    this.onFieldChange('message', updated);
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
}

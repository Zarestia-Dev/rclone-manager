import { Component, ChangeDetectionStrategy, input, output, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { WorkflowNode, WorkflowPort } from '../../../types/workflow.types';
import { getNodeStyleMeta, getNotificationIcon } from '../../../utils/node-style.util';
import { formatCronHumanReadable } from '../../../../../services/i18n/cron-locale.mapper';
import { MountManagementService } from '../../../../../services/operations/mount-management.service';
import { ServeManagementService } from '../../../../../services/operations/serve-management.service';
import { WorkflowStateService } from '../../../../../services/flow/workflow-state.service';

export interface NodePortRow {
  inputPort?: WorkflowPort;
  outputPort?: WorkflowPort;
}

@Component({
  selector: 'app-workflow-node',
  imports: [CommonModule, MatIconModule, TranslatePipe],
  templateUrl: './workflow-node.component.html',
  styleUrl: './workflow-node.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowNodeComponent {
  private readonly mountService = inject(MountManagementService);
  private readonly serveService = inject(ServeManagementService);
  private readonly stateService = inject(WorkflowStateService);
  private readonly translate = inject(TranslateService);

  readonly node = input.required<WorkflowNode>();
  readonly isSelected = input<boolean>(false);
  readonly zoom = input<number>(1);

  readonly displaySubtitle = computed(() => {
    const n = this.node();
    if (n.subtitle) return n.subtitle;
    if (n.type === 'cron') {
      const expr = String(n.config?.['cronExpression'] || '').trim();
      if (expr) {
        return formatCronHumanReadable(expr, this.translate.getCurrentLang() ?? 'en-US');
      }
    }
    return '';
  });

  readonly selectNode = output<string>();
  readonly deleteNode = output<string>();
  readonly duplicateNode = output<string>();
  readonly inspectNode = output<string>();
  readonly startConnecting = output<{ portId: string; event: MouseEvent }>();
  readonly portMouseUp = output<{ portId: string; event: MouseEvent }>();

  readonly styleMeta = computed(() => getNodeStyleMeta(this.node().type));
  readonly nodeIcon = computed(() => {
    const n = this.node();
    if (n.type === 'notification') {
      const kind = n.config?.['actionKind'] as string | undefined;
      if (kind) {
        return getNotificationIcon(kind);
      }
    }
    return n.icon || this.styleMeta().icon;
  });
  readonly nodePillClass = computed(() => this.styleMeta().pillClass);
  readonly nodeCssClass = computed(() => this.styleMeta().cssClass);
  readonly categoryPillClass = computed(() => this.nodePillClass());

  readonly isLiveMounted = computed(() => {
    const n = this.node();
    if (n.type !== 'mount') return false;
    const currentWfId = this.stateService.currentWorkflow()?.id;
    if (!currentWfId) return false;

    const mounts = this.mountService.mountedRemotes();
    return mounts.some(m => m.workflow_id === currentWfId && m.node_id === n.id);
  });

  readonly isLiveServing = computed(() => {
    const n = this.node();
    if (n.type !== 'serve') return false;
    const currentWfId = this.stateService.currentWorkflow()?.id;
    if (!currentWfId) return false;

    const serves = this.serveService.runningServes();
    return serves.some(s => s.workflow_id === currentWfId && s.node_id === n.id);
  });

  readonly isLiveActive = computed(() => this.isLiveMounted() || this.isLiveServing());

  readonly liveStatusLabelKey = computed(() => {
    if (this.isLiveMounted()) return 'flow.workflow.liveStatus.mounted';
    if (this.isLiveServing()) return 'flow.workflow.liveStatus.serving';
    return '';
  });

  readonly statusClass = computed(() => {
    const s = this.node().state || 'idle';
    return `status-${s}`;
  });

  readonly portRows = computed<NodePortRow[]>(() => {
    const inputs = this.node().inputs || [];
    const outputs = this.node().outputs || [];
    const maxRows = Math.max(inputs.length, outputs.length);
    const rows: NodePortRow[] = [];
    for (let i = 0; i < maxRows; i++) {
      rows.push({
        inputPort: inputs[i],
        outputPort: outputs[i],
      });
    }
    return rows;
  });

  onCardClick(event?: Event): void {
    event?.stopPropagation();
    this.selectNode.emit(this.node().id);
  }

  onDelete(event: MouseEvent): void {
    event.stopPropagation();
    this.deleteNode.emit(this.node().id);
  }

  onDuplicate(event: MouseEvent): void {
    event.stopPropagation();
    this.duplicateNode.emit(this.node().id);
  }

  onInspect(event: MouseEvent): void {
    event.stopPropagation();
    this.inspectNode.emit(this.node().id);
  }

  onPortMouseDown(port: WorkflowPort, event: MouseEvent): void {
    event.stopPropagation();
    this.startConnecting.emit({ portId: port.id, event });
  }

  onPortMouseUp(port: WorkflowPort, event: MouseEvent): void {
    event.stopPropagation();
    this.portMouseUp.emit({ portId: port.id, event });
  }
}

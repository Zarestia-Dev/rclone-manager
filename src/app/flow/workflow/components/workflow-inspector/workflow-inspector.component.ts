import {
  Component,
  ChangeDetectionStrategy,
  inject,
  computed,
  signal,
  effect,
  output,
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatOptionModule } from '@angular/material/core';
import { TranslatePipe } from '@ngx-translate/core';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowStorageService } from '../../../../services/flow/workflow-storage.service';
import { RemoteFacadeService } from '../../../../services/facade/remote-facade.service';
import { ModalService } from '../../../../services/ui/modal.service';
import { QuickRunService } from '../../../../services/flow/quick-run.service';
import { MountManagementService } from '../../../../services/operations/mount-management.service';
import { ServeManagementService } from '../../../../services/operations/serve-management.service';
import { ALL_PRIMARY_ACTIONS, PrimaryActionType, MountedRemote, ServeListItem } from '@app/types';
import {
  getNodeStyleMeta,
  getNotificationIcon,
  hasDetailedConfig,
} from '../../utils/node-style.util';
import {
  extractActiveConfigEntries,
  ActiveConfigItem,
  PRIMARY_EXCLUDED_KEYS,
} from '../../utils/config-entries.util';
import { getRcloneCfg } from '../../../../shared/utils/profile-config.util';
import { TriggerNodeFormComponent } from './node-forms/trigger-node-form.component';
import { TaskNodeFormComponent } from './node-forms/task-node-form.component';
import { LogicNodeFormComponent } from './node-forms/logic-node-form.component';
import { ActionNodeFormComponent } from './node-forms/action-node-form.component';
import { AlertBannerComponent } from '../../../../shared/components/alert-banner/alert-banner.component';

export { ActiveConfigItem, PRIMARY_EXCLUDED_KEYS };

@Component({
  selector: 'app-workflow-inspector',
  imports: [
    CommonModule,
    DatePipe,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatOptionModule,
    TranslatePipe,
    TriggerNodeFormComponent,
    TaskNodeFormComponent,
    LogicNodeFormComponent,
    ActionNodeFormComponent,
    AlertBannerComponent,
  ],
  templateUrl: './workflow-inspector.component.html',
  styleUrl: './workflow-inspector.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowInspectorComponent {
  readonly stateService = inject(WorkflowStateService);
  readonly storageService = inject(WorkflowStorageService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly modalService = inject(ModalService);
  private readonly quickRunService = inject(QuickRunService, { optional: true });
  private readonly mountService = inject(MountManagementService);
  private readonly serveService = inject(ServeManagementService);

  readonly closeInspector = output<void>();

  readonly selectedNode = this.stateService.selectedNode;
  readonly activeWorkflow = this.stateService.currentWorkflow;
  readonly remotes = computed(() => this.remoteFacade.orderedVisibleRemotes());
  readonly quickRuns = computed(() => this.quickRunService?.quickRuns() ?? []);

  readonly allProfiles = computed(() => {
    const profiles = new Set<string>();
    this.remotes().forEach(r => {
      const s = r?.status;
      if (!s) return;
      [s.sync, s.copy, s.bisync, s.move, s.mount, s.serve].forEach(op => {
        op?.configuredProfiles?.forEach(p => profiles.add(p));
      });
    });
    this.quickRuns().forEach(qr => {
      if (qr.name) profiles.add(qr.name);
    });
    return Array.from(profiles).sort();
  });

  readonly styleMeta = computed(() => {
    const node = this.selectedNode();
    return node ? getNodeStyleMeta(node.type) : null;
  });

  readonly nodeIcon = computed(() => {
    const node = this.selectedNode();
    if (!node) return 'workflow';
    if (node.type === 'notification') {
      const kind = this.nodeConfig()['actionKind'] as string | undefined;
      if (kind) {
        return getNotificationIcon(kind);
      }
    }
    return node.icon || this.styleMeta()?.icon || 'workflow';
  });

  readonly nodePillClass = computed(() => this.styleMeta()?.pillClass || 'p-dim');
  readonly nodeCssClass = computed(() => this.styleMeta()?.cssClass || 'dim');

  readonly hasDetailedConfig = computed(() => {
    const node = this.selectedNode();
    return node ? hasDetailedConfig(node.type) : false;
  });

  readonly isOperationNode = computed(() => {
    const node = this.selectedNode();
    return node ? ALL_PRIMARY_ACTIONS.includes(node.type as PrimaryActionType) : false;
  });

  // Form local state signals for selected node
  readonly nodeTitle = signal<string>('');
  readonly nodeSubtitle = signal<string>('');
  readonly nodeConfig = signal<Record<string, unknown>>({});

  // Form local state signals for active workflow
  readonly workflowName = signal<string>('');
  readonly workflowDescription = signal<string>('');

  readonly triggerNodesCount = computed(
    () => this.activeWorkflow()?.nodes.filter(n => n.category === 'trigger').length ?? 0
  );
  readonly taskNodesCount = computed(
    () => this.activeWorkflow()?.nodes.filter(n => n.category === 'task').length ?? 0
  );
  readonly logicNodesCount = computed(
    () => this.activeWorkflow()?.nodes.filter(n => n.category === 'logic').length ?? 0
  );
  readonly actionNodesCount = computed(
    () => this.activeWorkflow()?.nodes.filter(n => n.category === 'action').length ?? 0
  );

  constructor() {
    effect(() => {
      const node = this.selectedNode();
      if (node) {
        this.nodeTitle.set(node.title);
        this.nodeSubtitle.set(node.subtitle ?? '');
        this.nodeConfig.set(structuredClone(node.config || {}));
      }
    });

    effect(() => {
      const wf = this.activeWorkflow();
      if (wf) {
        this.workflowName.set(wf.name);
        this.workflowDescription.set(wf.description ?? '');
      }
    });
  }

  readonly resolvedRcloneConfig = computed<Record<string, unknown>>(() => {
    const cfg = this.nodeConfig();
    return (
      getRcloneCfg(cfg['config'] ?? cfg) ??
      ((cfg['config'] as Record<string, unknown> | undefined)?.['rclone'] as
        Record<string, unknown> | undefined) ??
      (cfg as Record<string, unknown>)
    );
  });

  readonly inspectorRemote = computed(() => {
    const cfg = this.nodeConfig();
    return (cfg['remoteName'] ?? cfg['remote'] ?? '') as string;
  });

  readonly inspectorSource = computed(() => {
    const rclone = this.resolvedRcloneConfig();
    const rawSrc =
      rclone['srcFs'] ?? rclone['path1'] ?? rclone['fs'] ?? rclone['source'] ?? rclone['url'];
    return Array.isArray(rawSrc) ? (rawSrc[0] ?? '') : rawSrc != null ? String(rawSrc) : '';
  });

  readonly inspectorDest = computed(() => {
    const rclone = this.resolvedRcloneConfig();
    const rawDst = rclone['mountPoint'] ?? rclone['dstFs'] ?? rclone['path2'] ?? rclone['dest'];
    return Array.isArray(rawDst) ? (rawDst[0] ?? '') : rawDst != null ? String(rawDst) : '';
  });

  readonly inspectorServeType = computed(() => {
    const rclone = this.resolvedRcloneConfig();
    return String(rclone['serveType'] || rclone['type'] || 'http');
  });

  readonly inspectorServeAddr = computed(() => {
    const rclone = this.resolvedRcloneConfig();
    const addr = rclone['addr'];
    return Array.isArray(addr) ? String(addr[0] ?? '') : addr != null ? String(addr) : '';
  });

  readonly availableMountNodes = computed(() => {
    const wf = this.activeWorkflow();
    if (!wf) return [];
    const currentId = this.selectedNode()?.id;
    return wf.nodes.filter(n => n.type === 'mount' && n.id !== currentId);
  });

  readonly availableServeNodes = computed(() => {
    const wf = this.activeWorkflow();
    if (!wf) return [];
    const currentId = this.selectedNode()?.id;
    return wf.nodes.filter(n => n.type === 'serve' && n.id !== currentId);
  });

  readonly activeMount = computed<MountedRemote | null>(() => {
    const node = this.selectedNode();
    if (!node || node.type !== 'mount') return null;
    const currentWf = this.activeWorkflow();
    if (!currentWf) return null;

    const mounts = this.mountService.mountedRemotes();
    return mounts.find(m => m.workflow_id === currentWf.id && m.node_id === node.id) ?? null;
  });

  readonly activeServe = computed<ServeListItem | null>(() => {
    const node = this.selectedNode();
    if (!node || node.type !== 'serve') return null;
    const currentWf = this.activeWorkflow();
    if (!currentWf) return null;

    const serves = this.serveService.runningServes();
    return serves.find(s => s.workflow_id === currentWf.id && s.node_id === node.id) ?? null;
  });

  readonly activeServeUrl = computed(() => {
    const s = this.activeServe();
    if (!s || !s.addr) return '';
    let addr = s.addr;
    if (addr.startsWith(':')) {
      addr = `127.0.0.1${addr}`;
    }
    const proto = String(s.params?.type || 'http').toLowerCase();
    if (
      addr.startsWith('http://') ||
      addr.startsWith('https://') ||
      addr.startsWith('webdav://') ||
      addr.startsWith('ftp://')
    ) {
      return addr;
    }
    const urlProto = proto === 'webdav' || proto === 'restic' ? 'http' : proto;
    return `${urlProto}://${addr}`;
  });

  readonly activeConfigEntries = computed<ActiveConfigItem[]>(() =>
    extractActiveConfigEntries(this.nodeConfig())
  );

  updateNodeRclonePath(key: string, value: unknown): void {
    const node = this.selectedNode();
    if (!node) return;
    const cfg = structuredClone(this.nodeConfig());
    if (!cfg['config'] || typeof cfg['config'] !== 'object') {
      cfg['config'] = { rclone: {} };
    }
    const innerConfig = cfg['config'] as { rclone?: Record<string, unknown> };
    if (!innerConfig.rclone || typeof innerConfig.rclone !== 'object') {
      innerConfig.rclone = {};
    }
    innerConfig.rclone[key] = value;
    this.nodeConfig.set(cfg);
    this.stateService.updateNodeConfig(node.id, cfg);
  }

  onInspectorRemoteChange(val: string): void {
    const node = this.selectedNode();
    if (!node) return;
    const cfg = structuredClone(this.nodeConfig());
    cfg['remoteName'] = val;
    this.nodeConfig.set(cfg);
    this.stateService.updateNodeConfig(node.id, cfg);
  }

  onInspectorSourceChange(val: string): void {
    const node = this.selectedNode();
    if (!node) return;
    const type = node.type;
    const key =
      type === 'mount' || type === 'serve'
        ? 'fs'
        : type === 'bisync'
          ? 'path1'
          : type === 'copyurl'
            ? 'url'
            : 'srcFs';
    this.updateNodeRclonePath(key, val);
  }

  onInspectorDestChange(val: string): void {
    const node = this.selectedNode();
    if (!node) return;
    const type = node.type;
    const key = type === 'mount' ? 'mountPoint' : type === 'bisync' ? 'path2' : 'dstFs';
    this.updateNodeRclonePath(key, val);
  }

  onServeTypeChange(val: string): void {
    this.updateNodeRclonePath('serveType', val);
    this.updateNodeRclonePath('type', val);
  }

  onServeAddrChange(val: string): void {
    this.updateNodeRclonePath('addr', val ? [val] : []);
  }

  onRcloneFieldChange(key: string, value: unknown): void {
    this.updateNodeRclonePath(key, value);
  }

  async unmountActive(): Promise<void> {
    const mount = this.activeMount();
    if (!mount) return;
    const remoteName = this.inspectorRemote() || mount.fs.replace(/:.*/, '');
    await this.mountService.unmountRemote(mount.mount_point, remoteName);
  }

  async stopActiveServe(): Promise<void> {
    const serve = this.activeServe();
    if (!serve) return;
    const remoteName = this.inspectorRemote() || serve.params?.fs?.replace(/:.*/, '') || '';
    await this.serveService.stopServe(serve.id, remoteName);
  }

  onTitleChange(newTitle: string): void {
    const node = this.selectedNode();
    if (!node) return;
    this.nodeTitle.set(newTitle);
    this.stateService.updateNodeMetadata(node.id, { title: newTitle });
  }

  onSubtitleChange(newSubtitle: string): void {
    const node = this.selectedNode();
    if (!node) return;
    this.nodeSubtitle.set(newSubtitle);
    this.stateService.updateNodeMetadata(node.id, { subtitle: newSubtitle });
  }

  onConfigFieldChange(key: string, value: unknown): void {
    const node = this.selectedNode();
    if (!node) return;
    const current = { ...this.nodeConfig(), [key]: value };
    this.nodeConfig.set(current);
    this.stateService.updateNodeConfig(node.id, { [key]: value });

    if (node.type === 'notification') {
      if (key === 'actionKind') {
        const icon = getNotificationIcon(value as string);
        this.stateService.updateNodeMetadata(node.id, { icon });
      } else if (key === 'icon') {
        this.stateService.updateNodeMetadata(node.id, { icon: value as string });
      }
    }
  }

  removeConfigItem(path: string): void {
    const node = this.selectedNode();
    if (!node) return;
    this.stateService.removeConfigField(node.id, path);
  }

  openDetailedSettings(): void {
    const node = this.selectedNode();
    if (!node || !this.hasDetailedConfig()) return;
    this.modalService.openWorkflowNodeEditor(node);
  }

  onWorkflowNameChange(newName: string): void {
    this.workflowName.set(newName);
    this.stateService.setWorkflowName(newName);
  }

  onWorkflowDescriptionChange(newDesc: string): void {
    this.workflowDescription.set(newDesc);
    this.stateService.setWorkflowDescription(newDesc);
  }

  saveActiveWorkflow(): void {
    const wf = this.stateService.currentWorkflow();
    if (wf) {
      void this.storageService.saveWorkflow(wf);
    }
  }

  async duplicateActiveWorkflow(): Promise<void> {
    const wf = this.stateService.currentWorkflow();
    if (!wf) return;
    await this.storageService.duplicateWorkflowWithFeedback(wf.id);
  }

  async exportActiveWorkflowJson(): Promise<void> {
    const wf = this.stateService.currentWorkflow();
    if (!wf) return;
    const jsonStr = await this.storageService.exportWorkflowJson(wf);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (wf.name || 'workflow').replace(/[^a-z0-9_-]/gi, '_');
    a.download = `${safeName}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async deleteActiveWorkflow(): Promise<void> {
    const wf = this.stateService.currentWorkflow();
    if (!wf) return;
    await this.storageService.promptAndDeleteWorkflow(wf.id);
  }

  closeInspectorPanel(): void {
    if (this.selectedNode()) {
      this.stateService.clearSelection();
    } else {
      this.closeInspector.emit();
    }
  }
}

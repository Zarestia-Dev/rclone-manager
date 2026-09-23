import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { TranslatePipe } from '@ngx-translate/core';
import { WorkflowNode } from '../../types/workflow.types';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { RemoteFacadeService } from '../../../../services/facade/remote-facade.service';
import {
  extractFieldsFromObject,
  getAvailableUpstreamNodes,
  getNodeFields,
  getNodeFieldsForType,
  NodeVariableField,
} from '../../utils/node-fields.util';
import { RcPresetCategory, RcPresetItem, RC_PRESETS } from '../../constants/rc-presets.constant';
import { EscapeCloseDirective } from '../../../../shared/directives/escape-close.directive';

export interface RcEditorModalData {
  node: WorkflowNode;
}

@Component({
  selector: 'app-rc-editor-modal',
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    TranslatePipe,
  ],
  hostDirectives: [EscapeCloseDirective],
  templateUrl: './rc-editor-modal.component.html',
  styleUrls: ['./rc-editor-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RcEditorModalComponent {
  readonly dialogRef = inject(MatDialogRef<RcEditorModalComponent>);
  readonly data: RcEditorModalData = inject(MAT_DIALOG_DATA);
  private readonly workflowState = inject(WorkflowStateService, { optional: true });
  private readonly workflowEngine = inject(WorkflowEngineService);
  private readonly remoteFacade = inject(RemoteFacadeService, { optional: true });

  @ViewChild('paramsTextarea') paramsTextarea?: ElementRef<HTMLTextAreaElement>;

  readonly command = signal<string>(
    (this.data?.node?.config?.['command'] as string) || 'core/version'
  );
  readonly rawParamsJson = signal<string>('');
  readonly sampleOutputJson = signal<string>('');
  readonly activePresetCategory = signal<RcPresetCategory>('all');
  readonly selectedVariableNodeId = signal<string>('');
  readonly selectedVariableField = signal<string>('');

  // Live test runner state
  readonly isTesting = signal<boolean>(false);
  readonly testResult = signal<{
    success: boolean;
    data?: unknown;
    error?: string;
    timeMs?: number;
    jsonString?: string;
  } | null>(null);

  readonly remotes = computed(() => this.remoteFacade?.orderedVisibleRemotes() ?? []);
  readonly rcPresets: RcPresetItem[] = RC_PRESETS;

  readonly filteredPresets = computed(() => {
    const cat = this.activePresetCategory();
    if (cat === 'all') return this.rcPresets;
    return this.rcPresets.filter(p => p.category === cat);
  });

  readonly availableUpstreamNodes = computed<WorkflowNode[]>(() => {
    return getAvailableUpstreamNodes(
      this.workflowState?.currentWorkflow()?.nodes,
      this.data?.node?.id
    );
  });

  readonly availableFieldsForSelectedNode = computed<NodeVariableField[]>(() => {
    const targetId = this.activeVariableNodeId();
    if (!targetId) return [];
    if (targetId === 'prev') {
      return getNodeFieldsForType('prev');
    }
    const target = this.availableUpstreamNodes().find(n => n.id === targetId);
    if (!target) return [];
    return getNodeFields(target);
  });

  readonly activeVariableNodeId = computed(() => {
    const explicit = this.selectedVariableNodeId();
    if (explicit) return explicit;
    const nodes = this.availableUpstreamNodes();
    return nodes.length > 0 ? nodes[0].id : '';
  });

  readonly activeVariableField = computed(() => {
    const explicit = this.selectedVariableField();
    if (explicit) return explicit;
    const fields = this.availableFieldsForSelectedNode();
    return fields.length > 0 ? fields[0].key : '';
  });

  readonly selectedTokenPreview = computed(() => {
    const nId = this.activeVariableNodeId();
    const fKey = this.activeVariableField();
    if (!nId || !fKey) return '';
    if (nId === 'prev') {
      return `{{prev.${fKey}}}`;
    }
    return `{{nodes.${nId}.${fKey}}}`;
  });

  readonly jsonStatus = computed<{ valid: boolean; isTemplate: boolean; error?: string }>(() => {
    const raw = this.rawParamsJson().trim();
    if (!raw) return { valid: true, isTemplate: false };
    if (raw.includes('{{') && raw.includes('}}')) {
      const dummySubstituted = raw
        .replace(/"\{\{[^}]+\}\}"/g, '"__token__"')
        .replace(/\{\{[^}]+\}\}/g, '"__token__"');
      try {
        JSON.parse(dummySubstituted);
        return { valid: true, isTemplate: true };
      } catch (e) {
        return { valid: false, isTemplate: true, error: (e as Error).message };
      }
    }
    try {
      JSON.parse(raw);
      return { valid: true, isTemplate: false };
    } catch (e) {
      return { valid: false, isTemplate: false, error: (e as Error).message };
    }
  });

  readonly sampleOutputKeys = computed<NodeVariableField[]>(() => {
    const raw = this.sampleOutputJson().trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return extractFieldsFromObject(parsed);
    } catch {
      return [];
    }
  });

  constructor() {
    const currentParams = this.data?.node?.config?.['params'];
    if (currentParams !== undefined && currentParams !== null) {
      if (typeof currentParams === 'string') {
        this.rawParamsJson.set(currentParams);
      } else if (typeof currentParams === 'object') {
        this.rawParamsJson.set(
          Object.keys(currentParams).length === 0 ? '' : JSON.stringify(currentParams, null, 2)
        );
      } else {
        this.rawParamsJson.set(String(currentParams));
      }
    }

    const currentSample = this.data?.node?.config?.['sampleOutput'];
    if (currentSample) {
      if (typeof currentSample === 'string') {
        this.sampleOutputJson.set(currentSample);
      } else {
        this.sampleOutputJson.set(JSON.stringify(currentSample, null, 2));
      }
    }
  }

  setPresetCategory(cat: RcPresetCategory): void {
    this.activePresetCategory.set(cat);
  }

  applyRcPreset(cmd: string, defaultParams?: Record<string, unknown>): void {
    this.command.set(cmd);
    if (defaultParams && Object.keys(defaultParams).length > 0) {
      const current = this.rawParamsJson().trim();
      if (!current || current === '{}') {
        const resolved = { ...defaultParams };
        if (resolved['fs'] === 'remote:') {
          const first = this.remotes()[0]?.name;
          if (first) {
            resolved['fs'] = `${first}:`;
          }
        }
        this.rawParamsJson.set(JSON.stringify(resolved, null, 2));
      }
    }
  }

  formatJson(): void {
    const raw = this.rawParamsJson().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      this.rawParamsJson.set(JSON.stringify(parsed, null, 2));
    } catch {
      // ignore syntax errors
    }
  }

  clearParams(): void {
    this.rawParamsJson.set('');
  }

  async testRun(): Promise<void> {
    const cmd = this.command().trim();
    if (!cmd) return;

    this.isTesting.set(true);
    this.testResult.set(null);
    const startTime = performance.now();

    const raw = this.rawParamsJson().trim();
    let parsedParams: unknown = undefined;
    if (raw) {
      try {
        parsedParams = JSON.parse(raw);
      } catch {
        parsedParams = raw;
      }
    }

    try {
      const res = await this.workflowEngine.testRcCommand(cmd, parsedParams);
      const elapsed = Math.round(performance.now() - startTime);
      this.testResult.set({
        success: true,
        data: res,
        timeMs: elapsed,
        jsonString: JSON.stringify(res, null, 2),
      });
    } catch (err: unknown) {
      const elapsed = Math.round(performance.now() - startTime);
      const msg = err instanceof Error ? err.message : String(err);
      this.testResult.set({
        success: false,
        error: msg,
        timeMs: elapsed,
      });
    } finally {
      this.isTesting.set(false);
    }
  }

  saveTestAsSample(): void {
    const tr = this.testResult();
    if (tr?.jsonString) {
      this.sampleOutputJson.set(tr.jsonString);
    }
  }

  formatSampleOutputJson(): void {
    const raw = this.sampleOutputJson().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      this.sampleOutputJson.set(JSON.stringify(parsed, null, 2));
    } catch {
      // ignore syntax errors
    }
  }

  onVariableNodeSelect(nodeId: string): void {
    this.selectedVariableNodeId.set(nodeId);
    this.selectedVariableField.set('');
  }

  onVariableFieldSelect(fieldKey: string): void {
    this.selectedVariableField.set(fieldKey);
  }

  insertToken(token: string): void {
    if (!token) return;
    const textarea = this.paramsTextarea?.nativeElement;
    const current = this.rawParamsJson();

    if (textarea) {
      const start = textarea.selectionStart ?? current.length;
      const end = textarea.selectionEnd ?? current.length;
      const next = current.substring(0, start) + token + current.substring(end);
      this.rawParamsJson.set(next);
      setTimeout(() => {
        textarea.focus();
        const cursor = start + token.length;
        textarea.setSelectionRange(cursor, cursor);
      });
    } else if (!current.trim()) {
      this.rawParamsJson.set(JSON.stringify({ fs: token }, null, 2));
    } else {
      this.rawParamsJson.set(current + token);
    }
  }

  insertSelectedToken(): void {
    const token = this.selectedTokenPreview();
    if (token) {
      this.insertToken(token);
    }
  }

  dismiss(): void {
    this.dialogRef.close();
  }

  save(): void {
    const cmd = this.command().trim();
    const raw = this.rawParamsJson().trim();
    let finalParams: unknown = {};

    if (raw) {
      try {
        finalParams = JSON.parse(raw);
      } catch {
        finalParams = raw;
      }
    }

    const sampleRaw = this.sampleOutputJson().trim();
    const sampleOutput = sampleRaw || undefined;

    if (this.data?.node?.id && this.workflowState) {
      this.workflowState.updateNodeConfig(this.data.node.id, {
        command: cmd,
        params: finalParams,
        sampleOutput,
      });
    }

    this.dialogRef.close({ command: cmd, params: finalParams, sampleOutput });
  }
}

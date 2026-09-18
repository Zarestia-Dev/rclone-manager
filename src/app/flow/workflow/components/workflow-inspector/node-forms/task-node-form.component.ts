import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  inject,
  computed,
  signal,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatOptionModule } from '@angular/material/core';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TranslatePipe } from '@ngx-translate/core';
import { WorkflowNode } from '../../../types/workflow.types';
import { QuickRun } from '@app/types';
import {
  getAvailableUpstreamNodes,
  getNodeFields,
  NodeVariableField,
} from '../../../utils/node-fields.util';
import { WorkflowStateService } from '../../../../../services/flow/workflow-state.service';
import { FileSystemService } from '../../../../../services/operations/file-system.service';
import { SUPPORTED_ARCHIVE_FORMATS } from '../../../../../services/remote/flag-definitions';
import { hasDetailedConfig } from '../../../utils/node-style.util';

interface RemoteItem {
  name: string;
  type?: string;
}

import { RcPresetCategory, RcPresetItem, RC_PRESETS } from '../../../constants/rc-presets.constant';

@Component({
  selector: 'app-task-node-form',
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatOptionModule,
    MatSlideToggleModule,
    TranslatePipe,
  ],
  templateUrl: './task-node-form.component.html',
  styleUrl: '../workflow-inspector.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskNodeFormComponent {
  private readonly stateService = inject(WorkflowStateService, { optional: true });
  private readonly fileSystemService = inject(FileSystemService, { optional: true });

  @ViewChild('paramsTextarea') paramsTextarea?: ElementRef<HTMLTextAreaElement>;

  readonly node = input.required<WorkflowNode>();
  readonly nodeConfig = input.required<Record<string, unknown>>();
  readonly remotes = input<RemoteItem[]>([]);
  readonly quickRuns = input<QuickRun[]>([]);

  readonly inspectorRemote = input<string>('');
  readonly inspectorSource = input<string>('');
  readonly inspectorDest = input<string>('');
  readonly inspectorServeType = input<string>('http');
  readonly inspectorServeAddr = input<string>('');

  readonly openDetailed = output<void>();
  readonly remoteChange = output<string>();
  readonly sourceChange = output<string>();
  readonly destChange = output<string>();
  readonly serveTypeChange = output<string>();
  readonly serveAddrChange = output<string>();
  readonly configChange = output<{ key: string; value: unknown }>();
  readonly rcloneFieldChange = output<{ key: string; value: unknown }>();

  readonly isDetailedConfigNode = computed(() => hasDetailedConfig(this.node().type));
  readonly isPrimaryOperationNode = computed(() => {
    const t = this.node().type;
    return t !== 'rc_command' && t !== 'cron' && hasDetailedConfig(t);
  });

  readonly rcParamCount = computed(() => {
    const p = this.nodeConfig()['params'];
    if (!p) return 0;
    if (typeof p === 'object') return Object.keys(p as object).length;
    if (typeof p === 'string' && p.trim()) return 1;
    return 0;
  });

  readonly selectedRemoteItem = computed<RemoteItem | undefined>(() => {
    const name = this.inspectorRemote();
    if (!name) return undefined;
    return this.remotes().find(r => r.name === name);
  });

  readonly archiveFormats = SUPPORTED_ARCHIVE_FORMATS;

  readonly archiveFormat = computed(() => {
    const cfg = this.nodeConfig();
    const rclone =
      ((cfg['config'] as Record<string, unknown> | undefined)?.['rclone'] as
        Record<string, unknown> | undefined) ??
      (cfg['rclone'] as Record<string, unknown> | undefined) ??
      cfg;
    return (rclone?.['format'] as string) || 'zip';
  });

  readonly archivePrefix = computed(() => {
    const cfg = this.nodeConfig();
    const rclone =
      ((cfg['config'] as Record<string, unknown> | undefined)?.['rclone'] as
        Record<string, unknown> | undefined) ??
      (cfg['rclone'] as Record<string, unknown> | undefined) ??
      cfg;
    return (rclone?.['prefix'] as string) || '';
  });

  onArchiveFormatChange(val: string): void {
    this.rcloneFieldChange.emit({ key: 'format', value: val });
  }

  onArchivePrefixChange(val: string): void {
    this.rcloneFieldChange.emit({ key: 'prefix', value: val });
  }

  readonly autoFilename = computed(() => {
    const cfg = this.nodeConfig();
    const rclone =
      ((cfg['config'] as Record<string, unknown> | undefined)?.['rclone'] as
        Record<string, unknown> | undefined) ??
      (cfg['rclone'] as Record<string, unknown> | undefined) ??
      cfg;
    return rclone?.['autoFilename'] !== false;
  });

  onAutoFilenameChange(val: boolean): void {
    this.rcloneFieldChange.emit({ key: 'autoFilename', value: val });
  }

  readonly availableUpstreamNodes = computed<WorkflowNode[]>(() => {
    return getAvailableUpstreamNodes(this.stateService?.currentWorkflow()?.nodes, this.node().id);
  });

  readonly selectedVariableNodeId = signal<string>('');
  readonly selectedVariableField = signal<string>('');

  readonly activeVariableNodeId = computed<string>(() => {
    return this.selectedVariableNodeId() || this.availableUpstreamNodes()[0]?.id || '';
  });

  readonly availableFieldsForSelectedNode = computed<NodeVariableField[]>(() => {
    const targetId = this.activeVariableNodeId();
    if (!targetId) return [];
    if (targetId === 'prev') {
      return [
        { key: 'summary', label: 'Summary (summary)' },
        { key: 'report', label: 'Check Report (report)' },
        { key: 'differ', label: 'Differing Files (differ)' },
        { key: 'hasDifferences', label: 'Has Differences (hasDifferences)' },
        { key: 'bytesFormatted', label: 'Formatted Bytes (bytesFormatted)' },
        { key: 'transfers', label: 'Transfers (transfers)' },
        { key: 'status', label: 'Status (status)' },
        { key: 'output', label: 'Output (output)' },
        { key: 'error', label: 'Error Message (error)' },
      ];
    }
    const targetNode = this.availableUpstreamNodes().find(n => n.id === targetId);
    return targetNode ? getNodeFields(targetNode) : [];
  });

  readonly activeVariableField = computed<string>(() => {
    const manual = this.selectedVariableField();
    const available = this.availableFieldsForSelectedNode();
    if (manual && available.some(f => f.key === manual)) {
      return manual;
    }
    return available[0]?.key || 'status';
  });

  readonly selectedTokenPreview = computed<string>(() => {
    const targetId = this.activeVariableNodeId();
    const field = this.activeVariableField();
    if (!targetId || !field) return '';
    if (targetId === 'prev') {
      return `{{prev.${field}}}`;
    }
    return `{{nodes.${targetId}.${field}}}`;
  });

  readonly activePresetCategory = signal<RcPresetCategory>('all');

  readonly filteredPresets = computed<RcPresetItem[]>(() => {
    const cat = this.activePresetCategory();
    if (cat === 'all') return this.rcPresets;
    return this.rcPresets.filter(p => p.category === cat);
  });

  setPresetCategory(category: RcPresetCategory): void {
    this.activePresetCategory.set(category);
  }

  readonly rcPresets: RcPresetItem[] = RC_PRESETS;

  readonly jsonStatus = computed<{ valid: boolean; isTemplate: boolean; error?: string }>(() => {
    const raw = this.getRcParamsJson().trim();
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

  onFieldChange(key: string, value: unknown): void {
    this.configChange.emit({ key, value });
  }

  applyRcPreset(command: string, defaultParams?: Record<string, unknown>): void {
    this.onFieldChange('command', command);
    if (defaultParams && Object.keys(defaultParams).length > 0) {
      const currentParams = this.nodeConfig()['params'];
      const isEmpty =
        !currentParams ||
        (typeof currentParams === 'object' && Object.keys(currentParams).length === 0) ||
        (typeof currentParams === 'string' &&
          (!currentParams.trim() || currentParams.trim() === '{}'));
      if (isEmpty) {
        const resolvedParams = { ...defaultParams };
        if (resolvedParams['fs'] === 'remote:') {
          const firstRemote = this.remotes()[0]?.name;
          if (firstRemote) {
            resolvedParams['fs'] = `${firstRemote}:`;
          }
        }
        this.onFieldChange('params', resolvedParams);
      }
    }
  }

  getRcParamsJson(): string {
    const params = this.nodeConfig()['params'];
    if (params === undefined || params === null) {
      return '';
    }
    if (typeof params === 'string') {
      return params;
    }
    if (typeof params === 'object') {
      if (Object.keys(params as object).length === 0) {
        return '';
      }
      return JSON.stringify(params, null, 2);
    }
    return String(params);
  }

  onRcParamsChange(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) {
      this.configChange.emit({ key: 'params', value: {} });
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        this.configChange.emit({ key: 'params', value: parsed });
        return;
      }
    } catch {
      // Keep raw string while typing or when containing template tokens (e.g. {{nodes.id.field}})
    }
    this.configChange.emit({ key: 'params', value });
  }

  formatJson(): void {
    const raw = this.getRcParamsJson().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      this.configChange.emit({ key: 'params', value: parsed });
    } catch {
      // Ignore if not valid JSON
    }
  }

  clearParams(): void {
    this.configChange.emit({ key: 'params', value: {} });
  }

  insertToken(token: string): void {
    const textarea = this.paramsTextarea?.nativeElement;
    const currentText = this.getRcParamsJson();

    if (textarea) {
      const start = textarea.selectionStart ?? currentText.length;
      const end = textarea.selectionEnd ?? currentText.length;
      const updated = currentText.substring(0, start) + token + currentText.substring(end);
      this.onRcParamsChange(updated);
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(start + token.length, start + token.length);
      });
    } else {
      if (!currentText.trim() || currentText.trim() === '{}') {
        this.onRcParamsChange(`{\n  "fs": "${token}"\n}`);
      } else {
        this.onRcParamsChange(currentText + ' ' + token);
      }
    }
  }

  insertSelectedToken(): void {
    const token = this.selectedTokenPreview();
    if (token) {
      this.insertToken(token);
    }
  }

  onVariableNodeSelect(nodeId: string): void {
    this.selectedVariableNodeId.set(nodeId);
    if (nodeId === 'prev') {
      this.selectedVariableField.set('summary');
    } else {
      const targetNode = this.availableUpstreamNodes().find(n => n.id === nodeId);
      const fields = targetNode ? getNodeFields(targetNode) : [];
      this.selectedVariableField.set(fields[0]?.key || 'status');
    }
  }

  onVariableFieldSelect(field: string): void {
    this.selectedVariableField.set(field);
  }

  async browseScriptCommand(): Promise<void> {
    if (!this.fileSystemService) return;
    try {
      const path = await this.fileSystemService.selectFile();
      if (path) {
        this.onFieldChange('command', path);
      }
    } catch {
      // user cancelled
    }
  }

  async browseWorkingDir(): Promise<void> {
    if (!this.fileSystemService) return;
    try {
      const path = await this.fileSystemService.selectFolder();
      if (path) {
        this.onFieldChange('workingDir', path);
      }
    } catch {
      // user cancelled
    }
  }

  async browseMountPoint(): Promise<void> {
    if (!this.fileSystemService) return;
    try {
      const path = await this.fileSystemService.selectFolder();
      if (path) {
        this.destChange.emit(path);
      }
    } catch {
      // user cancelled
    }
  }
}

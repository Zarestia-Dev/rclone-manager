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
import { getNodeFieldsForType } from '../../../utils/node-fields.util';
import { WorkflowStateService } from '../../../../../services/flow/workflow-state.service';
import { FileSystemService } from '../../../../../services/operations/file-system.service';
import { SUPPORTED_ARCHIVE_FORMATS } from '../../../../../services/remote/flag-definitions';
import { hasDetailedConfig } from '../../../utils/node-style.util';

interface RemoteItem {
  name: string;
  type?: string;
}

export type RcPresetCategory = 'all' | 'vfs' | 'ops' | 'core';

export interface RcPresetItem {
  category: 'vfs' | 'ops' | 'core';
  label: string;
  command: string;
  defaultParams?: Record<string, unknown>;
  title: string;
}

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
  styles: [
    `
      .rc-section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 4px;
        margin-bottom: 2px;

        .section-label {
          font-size: var(--font-size-xs, 11px);
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--dim-color);
        }

        .preset-filter-tabs {
          display: flex;
          gap: 2px;
          background: var(--bg-elevated-05, rgba(255, 255, 255, 0.04));
          padding: 2px;
          border-radius: var(--radius-xs, 4px);

          .tab-btn {
            background: transparent;
            border: none;
            color: var(--text-secondary, #a0a0a0);
            font-size: 10px;
            font-weight: 500;
            padding: 2px 6px;
            border-radius: 3px;
            cursor: pointer;
            transition: all 0.15s ease;

            &:hover {
              color: var(--window-fg-color, #fff);
            }

            &.active {
              background: var(--bg-elevated-2, rgba(255, 255, 255, 0.12));
              color: var(--accent-color, #3b82f6);
              font-weight: 600;
            }
          }
        }
      }

      .preset-pill {
        transition: all 0.15s ease;

        &.active {
          background: rgba(var(--accent-color-rgb, 59, 130, 246), 0.2);
          border-color: var(--accent-color, #3b82f6);
          color: var(--accent-color, #3b82f6);
          font-weight: 600;
        }
      }

      .params-header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 8px;
        margin-bottom: 2px;

        .params-header-left {
          display: flex;
          align-items: center;
          gap: 8px;

          .section-label {
            font-size: var(--font-size-xs, 11px);
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--dim-color);
          }

          .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 10px;
            padding: 1px 6px;
            border-radius: var(--radius-xs, 4px);
            font-weight: 500;

            mat-icon {
              width: 12px;
              height: 12px;
              font-size: 12px;
            }

            &.template {
              background: rgba(var(--primary-color-rgb, 59, 130, 246), 0.12);
              color: var(--primary-color, #3b82f6);
            }

            &.invalid {
              background: rgba(var(--warn-color-rgb, 239, 68, 68), 0.12);
              color: var(--warn-color, #ef4444);
            }
          }
        }

        .params-header-actions {
          display: flex;
          align-items: center;
          gap: 6px;

          .action-mini-btn {
            background: transparent;
            border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
            color: var(--text-secondary, #a0a0a0);
            font-size: 10px;
            padding: 2px 8px;
            border-radius: var(--radius-xs, 4px);
            cursor: pointer;
            transition: all 0.15s ease;

            &:hover {
              color: var(--window-fg-color, #fff);
              border-color: var(--accent-color, #3b82f6);
              background: rgba(var(--accent-color-rgb, 59, 130, 246), 0.1);
            }
          }
        }
      }

      .params-field {
        margin-bottom: -6px;
      }

      .var-helper-panel {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px;
        border-radius: var(--radius-sm, 8px);
        background: var(--bg-elevated-05, rgba(255, 255, 255, 0.03));
        border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));

        .var-helper-header {
          display: flex;
          align-items: center;
          gap: 6px;

          .helper-icon {
            width: 14px;
            height: 14px;
            font-size: 14px;
            color: var(--accent-color, #3b82f6);
          }

          .helper-title {
            font-size: 11px;
            font-weight: 600;
            color: var(--window-fg-color);
            text-transform: uppercase;
            letter-spacing: 0.04em;
          }
        }

        .var-picker-controls {
          display: flex;
          gap: 8px;

          .form-field-compact {
            flex: 1;
            font-size: 12px;
          }
        }

        .insert-token-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          width: 100%;
          padding: 6px 10px;
          background: rgba(var(--accent-color-rgb, 59, 130, 246), 0.1);
          border: 1px dashed rgba(var(--accent-color-rgb, 59, 130, 246), 0.35);
          border-radius: var(--radius-xs, 6px);
          color: var(--accent-color, #3b82f6);
          font-size: 11px;
          cursor: pointer;
          transition: all 0.15s ease;

          mat-icon {
            width: 14px;
            height: 14px;
            font-size: 14px;
          }

          code {
            font-family: var(--font-mono, monospace);
            font-size: 11px;
            background: rgba(var(--accent-color-rgb, 59, 130, 246), 0.15);
            padding: 1px 5px;
            border-radius: 4px;
          }

          &:hover {
            background: rgba(var(--accent-color-rgb, 59, 130, 246), 0.2);
            border-color: var(--accent-color, #3b82f6);
            transform: translateY(-1px);
          }
        }

        .no-nodes-hint {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: var(--dim-color);
          line-height: 1.4;
        }
      }
    `,
  ],
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
    const wf = this.stateService?.currentWorkflow();
    if (!wf?.nodes) return [];
    return wf.nodes.filter(n => n.id !== this.node().id);
  });

  readonly selectedVariableNodeId = signal<string>('');
  readonly selectedVariableField = signal<string>('');

  readonly activeVariableNodeId = computed<string>(() => {
    return this.selectedVariableNodeId() || this.availableUpstreamNodes()[0]?.id || '';
  });

  readonly availableFieldsForSelectedNode = computed<{ key: string; label: string }[]>(() => {
    const targetId = this.activeVariableNodeId();
    if (!targetId) return [];
    const targetNode = this.availableUpstreamNodes().find(n => n.id === targetId);
    return this.getNodeFieldsForType(targetNode?.type);
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

  readonly rcPresets: RcPresetItem[] = [
    // VFS
    {
      category: 'vfs',
      label: 'vfs/refresh',
      command: 'vfs/refresh',
      defaultParams: { recursive: true },
      title: 'Refresh active VFS cache',
    },
    {
      category: 'vfs',
      label: 'vfs/forget',
      command: 'vfs/forget',
      defaultParams: {},
      title: 'Forget directory or file in VFS cache',
    },
    // Storage Operations
    {
      category: 'ops',
      label: 'cleanup',
      command: 'operations/cleanup',
      defaultParams: { fs: 'remote:' },
      title: 'Empty trash or cleanup remote',
    },
    {
      category: 'ops',
      label: 'about',
      command: 'operations/about',
      defaultParams: { fs: 'remote:' },
      title: 'Get remote storage quota and free space',
    },
    {
      category: 'ops',
      label: 'fsinfo',
      command: 'operations/fsinfo',
      defaultParams: { fs: 'remote:' },
      title: 'Inspect remote filesystem features and hashes',
    },
    // Core Engine
    {
      category: 'core',
      label: 'bwlimit',
      command: 'core/bwlimit',
      defaultParams: { rate: '10M' },
      title: 'Adjust bandwidth speed limit (e.g. 10M, off)',
    },
    {
      category: 'core',
      label: 'core/stats',
      command: 'core/stats',
      defaultParams: {},
      title: 'Retrieve transfer and runtime stats',
    },
    {
      category: 'core',
      label: 'core/version',
      command: 'core/version',
      defaultParams: {},
      title: 'Retrieve rclone engine version and system details',
    },
  ];

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
    const targetNode = this.availableUpstreamNodes().find(n => n.id === nodeId);
    const fields = this.getNodeFieldsForType(targetNode?.type);
    this.selectedVariableField.set(fields[0]?.key || 'status');
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

  getNodeFieldsForType(type?: string): { key: string; label: string }[] {
    return getNodeFieldsForType(type);
  }
}

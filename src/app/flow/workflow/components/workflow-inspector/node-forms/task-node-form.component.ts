import { Component, ChangeDetectionStrategy, input, output, inject, computed } from '@angular/core';
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
import { FileSystemService } from '../../../../../services/operations/file-system.service';
import { SUPPORTED_ARCHIVE_FORMATS } from '../../../../../services/remote/flag-definitions';
import { hasDetailedConfig } from '../../../utils/node-style.util';

interface RemoteItem {
  name: string;
  type?: string;
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
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskNodeFormComponent {
  private readonly fileSystemService = inject(FileSystemService, { optional: true });

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

  onFieldChange(key: string, value: unknown): void {
    this.configChange.emit({ key, value });
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

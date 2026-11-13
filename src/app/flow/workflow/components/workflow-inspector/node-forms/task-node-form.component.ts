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
import { QuickRun, isSourceOnlyOperation } from '@app/types';
import { FileSystemService } from '../../../../../services/operations/file-system.service';
import { hasDetailedConfig } from '../../../utils/node-style.util';

import { PillDirective } from '../../../../../shared/directives/pill.directive';
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
    PillDirective,
  ],
  templateUrl: './task-node-form.component.html',
  styleUrl: '../workflow-inspector.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskNodeFormComponent {
  private readonly fileSystemService = inject(FileSystemService);

  readonly node = input.required<WorkflowNode>();
  readonly nodeConfig = input.required<Record<string, unknown>>();
  readonly remotes = input<RemoteItem[]>([]);
  readonly quickRuns = input<QuickRun[]>([]);

  /** The `rclone` settings of the node, wherever the workflow keeps them. */
  readonly rcloneConfig = input<Record<string, unknown>>({});

  readonly inspectorRemote = input<string>('');
  readonly inspectorSource = input<string>('');
  readonly inspectorDest = input<string>('');
  readonly inspectorServeType = input<string>('http');
  readonly inspectorServeAddr = input<string>('');

  /** Delete and index have a source and no destination. */
  readonly hasDestination = computed(() => !isSourceOnlyOperation(this.node().type));

  readonly openDetailed = output<void>();
  readonly configChange = output<{ key: string; value: unknown }>();

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

  readonly archiveFormat = computed(() => (this.rcloneConfig()['format'] as string) || 'zip');
  readonly archivePrefix = computed(() => (this.rcloneConfig()['prefix'] as string) || '');
  readonly autoFilename = computed(() => this.rcloneConfig()['autoFilename'] !== false);

  onFieldChange(key: string, value: unknown): void {
    this.configChange.emit({ key, value });
  }

  async browseScriptCommand(): Promise<void> {
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
    try {
      const path = await this.fileSystemService.selectFolder();
      if (path) {
        this.onFieldChange('workingDir', path);
      }
    } catch {
      // user cancelled
    }
  }
}
